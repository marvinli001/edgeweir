package namesilo

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Responses follow the JSON examples of the NameSilo API reference
// (https://www.namesilo.com/api-reference: dnsListRecords, dnsAddRecord,
// dnsUpdateRecord, dnsDeleteRecord, listDomains, Response Codes).
const key = "b9841238feb177a84330febb"

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	p, err := New(map[string]string{"api_token": key}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return p.(*Provider)
}

func auth(extra map[string]string) map[string]string {
	q := map[string]string{"version": "1", "type": "json", "key": key}
	for k, v := range extra {
		q[k] = v
	}
	return q
}

func ok(operation, body string) string {
	return `{"request":{"operation":"` + operation + `","ip":"55.555.55.55"},"reply":{"code":300,"detail":"success"` + body + `}}`
}

func listCall(records string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "GET", Path: "/dnsListRecords",
		Query:    auth(map[string]string{"domain": "example.com"}),
		Header:   map[string]string{"User-Agent": "edgeweir-certd/1"},
		Response: ok("dnsListRecords", `,"resource_record":[`+records+`]`),
	}
}

const existing = `{"record_id":"1a2b3c4d5e6f","type":"A","host":"www.example.com","value":"192.0.2.1","ttl":"7207","distance":"0"},
{"record_id":"5Brg5hw25jr","type":"A","host":"www.example.com","value":"192.0.2.2","ttl":"7207","distance":"0"},
{"record_id":"fH35aH4hsv","type":"TXT","host":"example.com","value":"keep","ttl":"3600","distance":"0"},
{"record_id":"a9a9a9a9a9","type":"CNAME","host":"cdn.example.com","value":"edge.example.net","ttl":"7207","distance":"0"},
{"record_id":"b8b8b8b8b8","type":"MX","host":"example.com","value":"mail.example.com","ttl":"7207","distance":"10"}`

func TestGetRecords(t *testing.T) {
	s := dnstest.Serve(t, listCall(existing))
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 5 || !dnstest.Has(records, "www", "A", "192.0.2.2") || !dnstest.Has(records, "@", "TXT", "keep") ||
		!dnstest.Has(records, "cdn", "CNAME", "edge.example.net") || !dnstest.Has(records, "@", "MX", "10 mail.example.com") {
		t.Fatalf("records: %+v", records)
	}
	if ttl := records[0].RR().TTL.Seconds(); ttl != 7207 {
		t.Fatalf("ttl: %v", ttl)
	}
}

func TestGetRecordsSingleAndEmpty(t *testing.T) {
	s := dnstest.Serve(t,
		// A zone with one record: resource_record is a bare object.
		dnstest.Exchange{Method: "GET", Path: "/dnsListRecords", Response: ok("dnsListRecords",
			`,"resource_record":{"record_id":"1","type":"TXT","host":"_acme-challenge.example.com","value":"token","ttl":3600,"distance":0}`)},
		dnstest.Exchange{Method: "GET", Path: "/dnsListRecords", Response: ok("dnsListRecords", "")},
	)
	p := provider(t, s)
	records, err := p.GetRecords(context.Background(), "example.com.")
	if err != nil || len(records) != 1 || !dnstest.Has(records, "_acme-challenge", "TXT", "token") {
		t.Fatalf("records %v err %v", records, err)
	}
	records, err = p.GetRecords(context.Background(), "example.com.")
	if err != nil || len(records) != 0 {
		t.Fatalf("records %v err %v", records, err)
	}
}

func TestAppendRecordsRaisesTheTTL(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{
			Method: "GET", Path: "/dnsAddRecord",
			Query:    auth(map[string]string{"domain": "example.com", "rrtype": "TXT", "rrhost": "_acme-challenge", "rrvalue": "token-value", "rrttl": "3600"}),
			Response: ok("dnsAddRecord", `,"record_id":"1a2b3c4d5e"`),
		},
		dnstest.Exchange{
			Method: "GET", Path: "/dnsAddRecord",
			Query: auth(map[string]string{"rrtype": "CNAME", "rrvalue": "edge.example.net", "rrttl": "7200"}),
			Check: func(t *testing.T, r *http.Request, _ []byte) {
				if host, set := r.URL.Query()["rrhost"]; !set || host[0] != "" {
					t.Errorf("apex rrhost %q", host)
				}
			},
			Response: ok("dnsAddRecord", `,"record_id":"2a2b3c4d5e"`),
		},
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", "token-value", 60), dnstest.CNAME("@", "edge.example.net.", 7200),
	})
	if err != nil || len(done) != 2 || done[0].RR().TTL.Seconds() != MinTTL {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsReplacesTheRRset(t *testing.T) {
	s := dnstest.Serve(t,
		listCall(existing),
		// 192.0.2.1 stays with a new TTL, 192.0.2.2 goes, 192.0.2.3 is created;
		// the other RRsets are untouched.
		dnstest.Exchange{Method: "GET", Path: "/dnsUpdateRecord", Query: auth(map[string]string{
			"domain": "example.com", "rrid": "1a2b3c4d5e6f", "rrhost": "www", "rrvalue": "192.0.2.1", "rrttl": "3600",
		}), Response: ok("dnsUpdateRecord", `,"record_id":"9z9z9z9z"`)},
		dnstest.Exchange{Method: "GET", Path: "/dnsDeleteRecord", Query: auth(map[string]string{"domain": "example.com", "rrid": "5Brg5hw25jr"}), Response: ok("dnsDeleteRecord", "")},
		dnstest.Exchange{Method: "GET", Path: "/dnsAddRecord", Query: auth(map[string]string{
			"domain": "example.com", "rrtype": "A", "rrhost": "www", "rrvalue": "192.0.2.3", "rrttl": "3600",
		}), Response: ok("dnsAddRecord", `,"record_id":"3a2b3c4d5e"`)},
	)
	set, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60),
	})
	if err != nil || len(set) != 2 {
		t.Fatalf("set %v err %v", set, err)
	}
}

func TestSetRecordsKeepsAnUnchangedRecord(t *testing.T) {
	s := dnstest.Serve(t, listCall(existing)) // TXT "keep" already has TTL 3600: no write
	if _, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{dnstest.TXT("@", "keep", 300)}); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		listCall(existing),
		dnstest.Exchange{Method: "GET", Path: "/dnsDeleteRecord", Query: auth(map[string]string{"rrid": "1a2b3c4d5e6f"}), Response: ok("dnsDeleteRecord", "")},
		dnstest.Exchange{Method: "GET", Path: "/dnsDeleteRecord", Query: auth(map[string]string{"rrid": "5Brg5hw25jr"}), Response: ok("dnsDeleteRecord", "")},
		dnstest.Exchange{Method: "GET", Path: "/dnsDeleteRecord", Query: auth(map[string]string{"rrid": "a9a9a9a9a9"}), Response: ok("dnsDeleteRecord", "")},
	)
	// The whole www A RRset (no data), the CNAME by data with a trailing dot,
	// and a record that does not exist.
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		libdns.RR{Name: "www", Type: "A"}, dnstest.CNAME("cdn", "EDGE.example.net.", 0), dnstest.TXT("@", "missing", 0),
	})
	if err != nil || len(deleted) != 3 || !dnstest.Has(deleted, "cdn", "CNAME", "edge.example.net") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZonesPages(t *testing.T) {
	var first []string
	for i := range 100 {
		first = append(first, fmt.Sprintf(`{"domain":"site%d.example","created":"2020-01-01","expires":"2030-01-01"}`, i))
	}
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/listDomains", Query: auth(map[string]string{"page": "1", "pageSize": "100"}),
			Response: ok("listDomains", `,"domains":[`+strings.Join(first, ",")+`],"pager":{"page":1,"pageSize":"100","total":"101"}`)},
		dnstest.Exchange{Method: "GET", Path: "/listDomains", Query: auth(map[string]string{"page": "2", "pageSize": "100"}),
			Response: ok("listDomains", `,"domains":[{"domain":"Example.COM","created":"1998-02-03","expires":"2030-02-03"}],"pager":{"page":2,"pageSize":"100","total":"101"}`)},
	)
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 101 || zones[0].Name != "site0.example." || zones[100].Name != "example.com." {
		t.Fatalf("zones %d err %v", len(zones), err)
	}
}

func TestListZonesLegacyShape(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{Method: "GET", Path: "/listDomains",
		Response: ok("listDomains", `,"domains":{"domain":["example.com","example.net"]}`)})
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	failure := func(code int, detail string) dnstest.Exchange {
		return dnstest.Exchange{Method: "GET", Path: "/dnsListRecords",
			Response: fmt.Sprintf(`{"request":{"operation":"dnsListRecords","ip":"55.555.55.55"},"reply":{"code":%d,"detail":%q}}`, code, detail)}
	}
	s := dnstest.Serve(t,
		failure(110, "Invalid API Key "+key), // a detail echoing the key is redacted
		failure(113, "This API account cannot be accessed from your IP"),
		failure(200, "Domain is not active, or does not belong to this user"),
		failure(400, "Existing API request is still processing"),
		dnstest.Exchange{Method: "GET", Path: "/dnsListRecords", Status: 502, Response: `bad gateway`},
	)
	p := provider(t, s)
	_, err := p.GetRecords(context.Background(), "example.com.")
	dnstest.NoSecret(t, err, key)
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("invalid key: %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "example.com."); !errors.Is(err, dnsx.ErrAuth) {
		t.Fatalf("IP restriction: %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "example.com."); !errors.Is(err, dnsx.ErrRateLimited) {
		t.Fatalf("busy: %v", err)
	}
	_, err = p.GetRecords(context.Background(), "example.com.")
	dnstest.NoSecret(t, err, key)
	if dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	for _, bad := range []string{"", "has space", "key&x=1", strings.Repeat("a", 129)} {
		if _, err := New(map[string]string{"api_token": bad}, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed key %q accepted: %v", bad, err)
		}
	}
	if _, err := p.AppendRecords(context.Background(), "example.com.", []libdns.Record{libdns.RR{Name: "@", Type: "MX", Data: "10 mail.example.com"}}); !errors.Is(err, dnsx.ErrUnsupported) {
		t.Fatalf("MX write: %v", err)
	}
}

// The key travels in the query string: transport errors and refused
// redirects must not quote the URL.
func TestTransportErrorsHideTheKey(t *testing.T) {
	p, err := New(map[string]string{"api_token": key}, dnsx.Options{BaseURL: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.GetRecords(context.Background(), "example.com.")
	dnstest.NoSecret(t, err, key)
	if dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("connection refused: %v", err)
	}

	s := dnstest.Serve(t, dnstest.Exchange{Method: "GET", Path: "/dnsListRecords", Status: 302,
		ResponseHeader: map[string]string{"Location": "https://attacker.example/"}})
	p, _ = New(map[string]string{"api_token": key}, dnsx.Options{BaseURL: s.URL}) // default client: no redirects
	_, err = p.GetRecords(context.Background(), "example.com.")
	dnstest.NoSecret(t, err, key)
	var status *dnsx.StatusError
	if !errors.As(err, &status) || status.Status != 302 {
		t.Fatalf("redirect: %v", err)
	}
}
