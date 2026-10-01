package ovh

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Requests and responses follow the OVHcloud API schema for /domain
// (https://eu.api.ovh.com/1.0/domain.json: domain.zone.Record,
// domain.zone.RecordCreate, domain.zone.RecordUpdate) and the signing rules of
// https://help.ovhcloud.com/csm/en-gb-api-getting-started-ovhcloud-api?id=kb_article_view&sysparm_article=KB0042784
// (full request URL signed, as in the official go-ovh and python-ovh clients).
// The keys are the example keys of that guide.
const (
	appKey      = "7kbG7Bk7S9Nt7ZSV"
	appSecret   = "EXEgWIz07P0HYwtQDs7cNIqCiQaWSuHF"
	consumerKey = "MtSwSrPpNjqfVSmJhLbPyr2i45lSwPU1"
	serverTime  = 1700000000
)

func fields() map[string]string {
	return map[string]string{"endpoint": "ovh-eu", "application_key": appKey, "application_secret": appSecret, "consumer_key": consumerKey}
}

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	p, err := New(fields(), dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	pr := p.(*Provider)
	pr.now = func() time.Time { return time.Unix(serverTime+100, 0) } // local clock 100 s ahead
	return pr
}

// authTime is the unauthenticated clock read before the first signed call.
func authTime() dnstest.Exchange {
	return dnstest.Exchange{
		Method: "GET", Path: "/auth/time",
		Check: func(t *testing.T, r *http.Request, _ []byte) {
			if r.Header.Get("X-Ovh-Signature") != "" || r.Header.Get("X-Ovh-Consumer") != "" {
				t.Error("/auth/time must not be signed")
			}
		},
		Response: fmt.Sprint(serverTime),
	}
}

// signed asserts the auth headers and recomputes the signature over the URL
// the server received.
func signed(t *testing.T, r *http.Request, body []byte) {
	t.Helper()
	target := "http://" + r.Host + r.URL.RequestURI()
	if got, want := r.Header.Get("X-Ovh-Signature"), sign(appSecret, consumerKey, r.Method, target, body, serverTime); got != want {
		t.Errorf("signature %s, want %s", got, want)
	}
}

func call(method, path string, query map[string]string, json any, response string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: method, Path: path, Query: query, JSON: json,
		Header: map[string]string{
			"X-Ovh-Application": appKey, "X-Ovh-Consumer": consumerKey,
			"X-Ovh-Timestamp": fmt.Sprint(serverTime), "User-Agent": "edgeweir-certd/1",
		},
		Check:    signed,
		Response: response,
	}
}

func recordJSON(id int, sub, typ, target string, ttl int) string {
	return fmt.Sprintf(`{"id":%d,"zone":"example.com","subDomain":%q,"fieldType":%q,"target":%q,"ttl":%d}`, id, sub, typ, target, ttl)
}

func getRecord(id int, sub, typ, target string, ttl int) dnstest.Exchange {
	return call("GET", fmt.Sprintf("/domain/zone/example.com/record/%d", id), nil, nil, recordJSON(id, sub, typ, target, ttl))
}

func refresh() dnstest.Exchange {
	return call("POST", "/domain/zone/example.com/refresh", nil, nil, "null")
}

func TestSignatureKnownAnswer(t *testing.T) {
	// Computed independently: sha1 of the "+"-joined fields.
	if got := sign(appSecret, consumerKey, "GET", "https://eu.api.ovh.com/1.0/domain/zone", nil, 1366560945); got != "$1$eba73e191a24380e0d8f7ab822e7166c788b2dec" {
		t.Fatalf("GET signature %s", got)
	}
	body := []byte(`{"fieldType":"TXT","subDomain":"_acme-challenge","target":"token","ttl":60}`)
	if got := sign(appSecret, consumerKey, "POST", "https://eu.api.ovh.com/1.0/domain/zone/example.com/record", body, 1700000000); got != "$1$d68776e39398b3f168e6a439b19ca5b276f19929" {
		t.Fatalf("POST signature %s", got)
	}
}

func TestGetRecords(t *testing.T) {
	s := dnstest.Serve(t,
		authTime(),
		call("GET", "/domain/zone/example.com/record", map[string]string{"fieldType": "", "subDomain": ""}, nil, `[11,12,13]`),
		getRecord(11, "www", "A", "192.0.2.1", 300),
		getRecord(12, "", "TXT", `"v=spf1 include:mx.ovh.com ~all"`, 0),
		getRecord(13, "cdn", "CNAME", "edge.example.net.", 60),
	)
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 3 || !dnstest.Has(records, "www", "A", "192.0.2.1") || !dnstest.Has(records, "@", "TXT", "v=spf1 include:mx.ovh.com ~all") || !dnstest.Has(records, "cdn", "CNAME", "edge.example.net") {
		t.Fatalf("records: %+v", records)
	}
	if records[0].RR().TTL != 300*time.Second {
		t.Fatalf("ttl: %v", records[0].RR().TTL)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		authTime(),
		call("POST", "/domain/zone/example.com/record", nil,
			map[string]any{"fieldType": "TXT", "subDomain": "_acme-challenge", "target": "token", "ttl": 60},
			recordJSON(21, "_acme-challenge", "TXT", `"token"`, 60)),
		call("POST", "/domain/zone/example.com/record", nil,
			map[string]any{"fieldType": "CNAME", "subDomain": "cdn", "target": "edge.example.net.", "ttl": 120},
			recordJSON(22, "cdn", "CNAME", "edge.example.net.", 120)),
		refresh(),
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", "token", 30), dnstest.CNAME("cdn", "edge.example.net", 120),
	})
	if err != nil || len(done) != 2 || !dnstest.Has(done, "_acme-challenge", "TXT", "token") || !dnstest.Has(done, "cdn", "CNAME", "edge.example.net.") {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsReplacesTheRRset(t *testing.T) {
	s := dnstest.Serve(t,
		authTime(),
		call("GET", "/domain/zone/example.com/record", map[string]string{"fieldType": "A", "subDomain": "www"}, nil, `[31,32]`),
		getRecord(31, "www", "A", "192.0.2.1", 300),
		getRecord(32, "www", "A", "192.0.2.2", 300),
		// 192.0.2.1 stays with a new TTL, 192.0.2.2 goes, 192.0.2.3 is created;
		// no other RRset is read or written.
		call("PUT", "/domain/zone/example.com/record/31", nil, map[string]any{"ttl": 60}, "null"),
		call("DELETE", "/domain/zone/example.com/record/32", nil, nil, "null"),
		call("POST", "/domain/zone/example.com/record", nil,
			map[string]any{"fieldType": "A", "subDomain": "www", "target": "192.0.2.3", "ttl": 60},
			recordJSON(33, "www", "A", "192.0.2.3", 60)),
		refresh(),
	)
	_, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60),
	})
	if err != nil {
		t.Fatal(err)
	}
	if body := string(s.Requests[4].Body); body != `{"ttl":60}` {
		t.Fatalf("update body %s", body)
	}
}

func TestSetRecordsUnchangedSkipsRefresh(t *testing.T) {
	s := dnstest.Serve(t,
		authTime(),
		call("GET", "/domain/zone/example.com/record", map[string]string{"fieldType": "CNAME", "subDomain": "cdn"}, nil, `[41]`),
		getRecord(41, "cdn", "CNAME", "edge.example.net.", 60),
	)
	if _, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{dnstest.CNAME("cdn", "Edge.Example.NET", 60)}); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		authTime(),
		// The subDomain filter is a LIKE: "_" also matched "xacme-challenge".
		call("GET", "/domain/zone/example.com/record", map[string]string{"fieldType": "TXT", "subDomain": "_acme-challenge"}, nil, `[51,52,53]`),
		getRecord(51, "_acme-challenge", "TXT", `"one"`, 60),
		getRecord(52, "_acme-challenge", "TXT", `"two"`, 60),
		getRecord(53, "xacme-challenge", "TXT", `"one"`, 60),
		call("DELETE", "/domain/zone/example.com/record/51", nil, nil, "null"),
		call("GET", "/domain/zone/example.com/record", map[string]string{"fieldType": "A", "subDomain": "old"}, nil, `[61,62]`),
		getRecord(61, "old", "A", "192.0.2.8", 60),
		getRecord(62, "old", "A", "192.0.2.9", 60),
		call("DELETE", "/domain/zone/example.com/record/61", nil, nil, "null"),
		call("DELETE", "/domain/zone/example.com/record/62", nil, nil, "null"),
		refresh(),
	)
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", "one", 60),
		libdns.RR{Name: "old", Type: "A"}, // whole RRset
	})
	if err != nil || len(deleted) != 3 || !dnstest.Has(deleted, "_acme-challenge", "TXT", "one") || !dnstest.Has(deleted, "old", "A", "192.0.2.9") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t, authTime(), call("GET", "/domain/zone", nil, nil, `["example.com","Example.NET"]`))
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestEndpoints(t *testing.T) {
	for name, want := range map[string]string{"": "https://eu.api.ovh.com/1.0", "ovh-ca": "https://ca.api.ovh.com/1.0", "ovh-us": "https://api.us.ovhcloud.com/1.0"} {
		f := fields()
		f["endpoint"] = name
		p, err := New(f, dnsx.Options{})
		if err != nil || p.(*Provider).base != want {
			t.Fatalf("endpoint %q: %v %v", name, p, err)
		}
	}
}

func failing(status int, response string) dnstest.Exchange {
	e := call("GET", "/domain/zone/example.com/record", nil, nil, response)
	e.Status = status
	return e
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		authTime(),
		failing(403, `{"errorCode":"INVALID_CREDENTIAL","httpCode":"403 Forbidden","message":"This credential is not valid"}`),
		failing(400, `{"errorCode":"INVALID_SIGNATURE","httpCode":"400 Bad Request","message":"Invalid signature"}`),
		failing(403, `{"class":"Client::Forbidden","message":"This call has not been granted"}`),
		failing(404, `{"class":"Client::NotFound","message":"This service does not exist"}`),
		failing(503, `{"class":"Server::ServiceUnavailable","message":"Service unavailable"}`),
	)
	p := provider(t, s)
	ctx := context.Background()
	for i := range 3 {
		_, err := p.GetRecords(ctx, "example.com.")
		dnstest.NoSecret(t, err, appSecret, consumerKey)
		if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
			t.Fatalf("auth failure %d: %v", i, err)
		}
	}
	if _, err := p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err := p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	if _, err := p.SetRecords(ctx, "example.com.", []libdns.Record{dnstest.CNAME("@", "edge.example.net", 60)}); !errors.Is(err, dnsx.ErrUnsupported) {
		t.Fatalf("apex CNAME: %v", err)
	}
	for _, change := range []map[string]string{{"endpoint": "kimsufi-eu"}, {"endpoint": "https://evil.example"}, {"application_key": ""}, {"application_secret": "short"}, {"consumer_key": consumerKey + "\n"}} {
		f := fields()
		for k, v := range change {
			f[k] = v
		}
		if _, err := New(f, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed fields accepted: %q", change)
		}
	}
}

func TestClockErrors(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{Method: "GET", Path: "/auth/time", Status: 502, Response: "bad gateway"})
	_, err := provider(t, s).ListZones(context.Background())
	if dnsx.Code(err) != "dns_provider_unreachable" || strings.Contains(err.Error(), consumerKey) {
		t.Fatalf("clock failure: %v", err)
	}
}
