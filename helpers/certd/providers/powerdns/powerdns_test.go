package powerdns

// Requests and responses follow the PowerDNS Authoritative HTTP API
// reference: https://doc.powerdns.com/authoritative/http-api/zone.html
// (GET /servers/{server_id}/zones, GET and PATCH
// /servers/{server_id}/zones/{zone_id}) and the error format of
// https://doc.powerdns.com/authoritative/http-api/index.html.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"testing"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const apiKey = "s3cr3t-pdns-api-key"

var loopback = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}

func provider(t *testing.T, s *dnstest.Server, extra map[string]string) *Provider {
	t.Helper()
	fields := map[string]string{"server_url": s.URL, "api_key": apiKey}
	for k, v := range extra {
		fields[k] = v
	}
	// No HTTPClient: the real policy client dials the test server on 127.0.0.1.
	p, err := New(fields, dnsx.Options{AllowCIDRs: loopback})
	if err != nil {
		t.Fatal(err)
	}
	return p.(*Provider)
}

var auth = map[string]string{"X-API-Key": apiKey, "User-Agent": "edgeweir-certd/1", "Accept": "application/json"}

const zonePath = "/api/v1/servers/localhost/zones/example.com."

// Zone document in the form of the reference example (GET zone with rrsets).
const zoneJSON = `{"account":"","api_rectify":false,"dnssec":false,"edited_serial":2022040501,"id":"example.com.","kind":"Native","name":"example.com.","serial":2022040501,"url":"/api/v1/servers/localhost/zones/example.com.","rrsets":[
{"comments":[],"name":"example.com.","records":[{"content":"a.misconfigured.dns.server.invalid. hostmaster.example.com. 2022040501 10800 3600 604800 3600","disabled":false}],"ttl":3600,"type":"SOA"},
{"comments":[],"name":"www.example.com.","records":[{"content":"192.0.2.1","disabled":false},{"content":"192.0.2.2","disabled":false},{"content":"192.0.2.9","disabled":true}],"ttl":600,"type":"A"},
{"comments":[],"name":"example.com.","records":[{"content":"\"keep \\\"me\\\"\"","disabled":false}],"ttl":600,"type":"TXT"},
{"comments":[{"account":"","content":"edge","modified_at":1700000000}],"name":"cdn.example.com.","records":[{"content":"edge.example.net.","disabled":false}],"ttl":300,"type":"CNAME"},
{"comments":[],"name":"_acme-challenge.example.com.","records":[{"content":"\"token-1\"","disabled":false},{"content":"\"caf\\195\\169\" \"x\"","disabled":false}],"ttl":60,"type":"TXT"}]}`

func getZone() dnstest.Exchange {
	return dnstest.Exchange{Method: "GET", Path: zonePath, Header: auth, Response: zoneJSON}
}

func patchZone(rrsets []map[string]any, check func(t *testing.T, r *http.Request, body []byte)) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "PATCH", Path: zonePath,
		Header: map[string]string{"X-API-Key": apiKey, "Content-Type": "application/json", "User-Agent": "edgeweir-certd/1"},
		JSON:   map[string]any{"rrsets": rrsets},
		Check:  check,
		Status: http.StatusNoContent,
	}
}

func TestGetRecords(t *testing.T) {
	s := dnstest.Serve(t, getZone())
	records, err := provider(t, s, nil).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	// SOA, 2 enabled A (the disabled one is skipped), apex TXT, CNAME, 2 TXT.
	if len(records) != 7 {
		t.Fatalf("records: %+v", records)
	}
	for _, want := range [][3]string{
		{"www", "A", "192.0.2.1"}, {"www", "A", "192.0.2.2"}, {"@", "TXT", `keep "me"`},
		{"cdn", "CNAME", "edge.example.net."}, {"_acme-challenge", "TXT", "token-1"}, {"_acme-challenge", "TXT", "café" + "x"},
	} {
		if !dnstest.Has(records, want[0], want[1], want[2]) {
			t.Errorf("missing %v in %+v", want, records)
		}
	}
	if dnstest.Has(records, "www", "A", "192.0.2.9") {
		t.Error("disabled record returned")
	}
	for _, r := range records {
		if rr := r.RR(); rr.Name == "cdn" && rr.TTL.Seconds() != 300 {
			t.Errorf("ttl: %v", rr.TTL)
		}
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		getZone(),
		patchZone([]map[string]any{
			// Union with the existing members; the disabled 192.0.2.9 is enabled.
			{"name": "www.example.com.", "type": "A", "ttl": 600, "changetype": "REPLACE", "records": []map[string]any{
				{"content": "192.0.2.1", "disabled": false}, {"content": "192.0.2.2", "disabled": false}, {"content": "192.0.2.9", "disabled": false},
			}},
			{"name": "_acme-challenge.example.com.", "type": "TXT", "ttl": 120, "changetype": "REPLACE", "records": []map[string]any{
				{"content": `"token-1"`}, {"content": `"caf\195\169" "x"`}, {"content": `"token \"2\""`},
			}},
			// A new RRset.
			{"name": "new.example.com.", "type": "CNAME", "ttl": 60, "changetype": "REPLACE", "records": []map[string]any{{"content": "target.example.net."}}},
		}, nil),
	)
	done, err := provider(t, s, nil).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.9", 600),
		dnstest.TXT("_acme-challenge", `token "2"`, 120),
		dnstest.CNAME("new", "target.example.net", 60),
	})
	if err != nil || len(done) != 3 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsReplacesTheRRset(t *testing.T) {
	s := dnstest.Serve(t, patchZone([]map[string]any{
		// 192.0.2.1 stays with a new TTL, 192.0.2.2 goes, 192.0.2.3 is created;
		// the apex TXT and the other RRsets are not in the request.
		{"name": "www.example.com.", "type": "A", "ttl": 60, "changetype": "REPLACE", "records": []map[string]any{
			{"content": "192.0.2.1", "disabled": false}, {"content": "192.0.2.3", "disabled": false},
		}},
		{"name": "cdn.example.com.", "type": "CNAME", "ttl": 300, "changetype": "REPLACE", "records": []map[string]any{{"content": "edge2.example.net."}}},
	}, func(t *testing.T, _ *http.Request, body []byte) {
		var got struct {
			RRsets []map[string]json.RawMessage `json:"rrsets"`
		}
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		for _, set := range got.RRsets {
			if _, ok := set["comments"]; ok {
				t.Error("REPLACE must not send comments (they would be overwritten)")
			}
		}
	}))
	_, err := provider(t, s, nil).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60), dnstest.A("WWW", "192.0.2.3", 60),
		dnstest.CNAME("cdn", "edge2.example.net.", 300),
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		getZone(),
		patchZone([]map[string]any{
			{"name": "cdn.example.com.", "type": "CNAME", "changetype": "DELETE"},
			{"name": "_acme-challenge.example.com.", "type": "TXT", "ttl": 60, "changetype": "REPLACE", "records": []map[string]any{{"content": `"caf\195\169" "x"`}}},
		}, func(t *testing.T, _ *http.Request, body []byte) {
			var got struct {
				RRsets []map[string]json.RawMessage `json:"rrsets"`
			}
			_ = json.Unmarshal(body, &got)
			if _, ok := got.RRsets[0]["ttl"]; ok {
				t.Error("DELETE must not carry a ttl")
			}
			if _, ok := got.RRsets[0]["records"]; ok {
				t.Error("DELETE must not carry records")
			}
		}),
	)
	deleted, err := provider(t, s, nil).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		libdns.RR{Name: "cdn", Type: "CNAME"}, // whole RRset
		dnstest.TXT("_acme-challenge", "token-1", 0),
		dnstest.A("www", "192.0.2.77", 0), // absent: ignored
	})
	if err != nil || len(deleted) != 2 || !dnstest.Has(deleted, "cdn", "CNAME", "edge.example.net") || !dnstest.Has(deleted, "_acme-challenge", "TXT", "token-1") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestDeleteNothingSendsNoPatch(t *testing.T) {
	s := dnstest.Serve(t, getZone())
	deleted, err := provider(t, s, nil).DeleteRecords(context.Background(), "example.com.", []libdns.Record{dnstest.TXT("_acme-challenge", "other", 0)})
	if err != nil || len(deleted) != 0 {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{
		Method: "GET", Path: "/api/v1/servers/pdns-1/zones", Header: auth,
		Response: `[{"account":"","dnssec":false,"edited_serial":2022040501,"id":"example.com.","kind":"Native","last_check":0,"masters":[],"name":"example.com.","notified_serial":0,"serial":2022040501,"url":"/api/v1/servers/localhost/zones/example.com."},
{"id":"Example.NET.","kind":"Master","name":"Example.NET.","url":"/api/v1/servers/localhost/zones/Example.NET."}]`,
	})
	zones, err := provider(t, s, map[string]string{"server_id": "pdns-1"}).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestZoneIDEncoding(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{Method: "GET", Path: "/api/v1/servers/localhost/zones/=5Finternal.example.com.", Response: `{"id":"=5Finternal.example.com.","name":"_internal.example.com.","rrsets":[]}`})
	if _, err := provider(t, s, nil).GetRecords(context.Background(), "_Internal.example.com"); err != nil {
		t.Fatal(err)
	}
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: zonePath, Status: 401, Response: `{"error":"Unauthorized"}`},
		dnstest.Exchange{Method: "GET", Path: zonePath, Status: 404, Response: `{"error":"Not Found"}`},
		dnstest.Exchange{Method: "PATCH", Path: zonePath, Status: 422, Response: `{"error":"RRset cdn.example.com. IN A: Conflicts with pre-existing RRset"}`},
		dnstest.Exchange{Method: "GET", Path: zonePath, Status: 500, Response: `{"error":"Backend error"}`},
	)
	p := provider(t, s, nil)
	_, err := p.GetRecords(context.Background(), "example.com.")
	dnstest.NoSecret(t, err, apiKey)
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("bad key: %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	_, err = p.SetRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("cdn", "192.0.2.1", 60)})
	if dnsx.Code(err) != "dns_provider_error" || err.Error() != "HTTP 422: RRset cdn.example.com. IN A: Conflicts with pre-existing RRset" {
		t.Fatalf("422: %v", err)
	}
	_, err = p.GetRecords(context.Background(), "example.com.")
	dnstest.NoSecret(t, err, apiKey)
	if dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
}

func TestPolicyRefusesLoopback(t *testing.T) {
	s := dnstest.Serve(t) // must not be reached
	p, err := New(map[string]string{"server_url": s.URL, "api_key": apiKey}, dnsx.Options{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.GetRecords(context.Background(), "example.com.")
	dnstest.NoSecret(t, err, apiKey)
	if !errors.Is(err, dnsx.ErrRefused) || dnsx.Code(err) != "dns_address_refused" {
		t.Fatalf("loopback without allow list: %v", err)
	}
}

func TestNewRejectsMalformedFields(t *testing.T) {
	good := map[string]string{"server_url": "https://pdns.example.net:8081", "api_key": apiKey}
	if _, err := New(good, dnsx.Options{}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []map[string]string{
		{"server_url": "https://pdns.example.net:8081/api/v1"},
		{"server_url": "https://admin:pw@pdns.example.net"},
		{"server_url": "https://pdns.example.net/?x=1"},
		{"server_url": "ftp://pdns.example.net"},
		{"server_url": "pdns.example.net:8081"},
		{"server_url": "https://pdns.example.net:0"},
		{"server_url": ""},
		{"api_key": ""},
		{"api_key": "two words"},
		{"server_id": "a/b"},
	} {
		fields := map[string]string{}
		for k, v := range good {
			fields[k] = v
		}
		for k, v := range bad {
			fields[k] = v
		}
		_, err := New(fields, dnsx.Options{})
		if !errors.Is(err, dnsx.ErrInvalid) {
			t.Errorf("%v accepted: %v", bad, err)
		}
		if err != nil {
			dnstest.NoSecret(t, err, apiKey, "two words", "pw@")
		}
	}
}

func TestTXTQuoting(t *testing.T) {
	long := make([]byte, 300)
	for i := range long {
		long[i] = 'a'
	}
	for text, want := range map[string]string{
		"":                   `""`,
		`a "b" \c`:           `"a \"b\" \\c"`,
		"é":                  `"\195\169"`,
		string(long[:256]):   `"` + string(long[:255]) + `" "a"`,
		"line\nbreak\x7fend": `"line\010break\127end"`,
	} {
		if got := quoteTXT(text); got != want {
			t.Errorf("quoteTXT(%q) = %q, want %q", text, got, want)
		}
		if back := unquoteTXT(want); back != text {
			t.Errorf("unquoteTXT(%q) = %q, want %q", want, back, text)
		}
	}
	if got := unquoteTXT("plain"); got != "plain" {
		t.Errorf("unquoted content: %q", got)
	}
}
