package gcore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Bodies follow the Gcore DNS API reference (OpenAPI "Gcore OpenAPI – DNS
// API", https://docs.gcore.com/api-reference/dns: RRSetList, RRSet,
// UpdateRRSet, DeleteRRSet, Zones) and the REST API error guide
// (https://docs.gcore.com/developer-tools/rest-api/error-handling).
const (
	token  = "7711$eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.c2VjcmV0"
	secret = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.c2VjcmV0"
)

var headers = map[string]string{"Authorization": "APIKey " + token, "User-Agent": "edgeweir-certd/1", "Accept": "application/json"}

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	p, err := New(map[string]string{"api_key": token}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return p.(*Provider)
}

const wwwA = `{"name":"www.example.com","type":"A","ttl":300,"resource_records":[
{"id":41,"content":["192.0.2.1"],"enabled":true,"meta":{}},
{"id":42,"content":["192.0.2.2"],"enabled":true,"meta":{"countries":["us"]}}],
"pickers":[{"type":"geodns","strict":false}],"meta":{},"updated_at":"2024-01-15T10:30:00Z"}`

func rrsets(total int, sets ...string) string {
	return fmt.Sprintf(`{"rrsets":[%s],"total_amount":%d}`, strings.Join(sets, ","), total)
}

// noKeys fails when the JSON body has any of the keys at the top level.
func noKeys(keys ...string) func(t *testing.T, r *http.Request, body []byte) {
	return func(t *testing.T, _ *http.Request, body []byte) {
		var got map[string]any
		if err := json.Unmarshal(body, &got); err != nil {
			t.Errorf("body: %v", err)
		}
		for _, k := range keys {
			if _, ok := got[k]; ok {
				t.Errorf("body has %q: %s", k, body)
			}
		}
	}
}

func TestGetRecordsPages(t *testing.T) {
	var first []string
	for i := range 1000 {
		first = append(first, fmt.Sprintf(`{"name":"h%d.example.com","type":"A","ttl":120,"resource_records":[{"id":%d,"content":["192.0.2.9"],"enabled":true}]}`, i, i))
	}
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/v2/zones/example.com/rrsets", Header: headers,
			Query: map[string]string{"limit": "1000", "offset": "0"}, Response: rrsets(1003, first...)},
		dnstest.Exchange{Method: "GET", Path: "/v2/zones/example.com/rrsets", Header: headers,
			Query: map[string]string{"limit": "1000", "offset": "1000"}, Response: rrsets(1003,
				wwwA,
				`{"name":"example.com","type":"TXT","ttl":3600,"resource_records":[{"id":7,"content":["v=spf1 -all"],"enabled":true}]}`,
				`{"name":"cdn.example.com.","type":"CNAME","ttl":60,"resource_records":[{"id":8,"content":["edge.example.net."],"enabled":true}]}`)},
	)
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1004 || !dnstest.Has(records, "h999", "A", "192.0.2.9") || !dnstest.Has(records, "www", "A", "192.0.2.1") ||
		!dnstest.Has(records, "www", "A", "192.0.2.2") || !dnstest.Has(records, "@", "TXT", "v=spf1 -all") || !dnstest.Has(records, "cdn", "CNAME", "edge.example.net") {
		t.Fatalf("records: %d", len(records))
	}
	if ttl := records[1000].RR().TTL.Seconds(); ttl != 300 {
		t.Fatalf("ttl %v", ttl)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		// Joins an existing RRset: members, their metadata and the pickers stay.
		dnstest.Exchange{Method: "GET", Path: "/v2/zones/example.com/www.example.com/A", Header: headers, Response: wwwA},
		dnstest.Exchange{Method: "PUT", Path: "/v2/zones/example.com/www.example.com/A", Header: map[string]string{"Content-Type": "application/json", "Authorization": "APIKey " + token},
			JSON: map[string]any{"ttl": 300, "pickers": []any{map[string]any{"type": "geodns", "strict": false}}, "resource_records": []any{
				map[string]any{"content": []any{"192.0.2.1"}, "enabled": true},
				map[string]any{"content": []any{"192.0.2.2"}, "enabled": true, "meta": map[string]any{"countries": []any{"us"}}},
				map[string]any{"content": []any{"192.0.2.3"}},
			}},
			Check:    noKeys("name", "type", "meta"),
			Response: wwwA},
		// A new RRset.
		dnstest.Exchange{Method: "GET", Path: "/v2/zones/example.com/_acme-challenge.example.com/TXT", Status: 404, Response: `{"error":"record is not found"}`},
		dnstest.Exchange{Method: "PUT", Path: "/v2/zones/example.com/_acme-challenge.example.com/TXT",
			JSON:     map[string]any{"ttl": 60, "resource_records": []any{map[string]any{"content": []any{"token-value"}}}},
			Response: `{"name":"_acme-challenge.example.com","type":"TXT","ttl":60,"resource_records":[{"id":50,"content":["token-value"],"enabled":true}]}`},
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.3", 60), dnstest.A("www", "192.0.2.1", 60), dnstest.TXT("_acme-challenge", "token-value", 60),
	})
	if err != nil || len(done) != 2 || done[0].RR().TTL.Seconds() != 300 || !dnstest.Has(done, "_acme-challenge", "TXT", "token-value") {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsPutsTheWholeRRset(t *testing.T) {
	s := dnstest.Serve(t,
		// 192.0.2.1 stays (TTL 300 -> 60), 192.0.2.2 goes, 192.0.2.3 is added in
		// one PUT; the TXT RRset at the apex is not touched.
		dnstest.Exchange{Method: "PUT", Path: "/v2/zones/example.com/www.example.com/A", Header: headers,
			JSON: map[string]any{"ttl": 60, "resource_records": []any{
				map[string]any{"content": []any{"192.0.2.1"}}, map[string]any{"content": []any{"192.0.2.3"}},
			}},
			Check:    noKeys("pickers", "meta", "name"),
			Response: `{"name":"www.example.com","type":"A","ttl":60,"resource_records":[{"id":41,"content":["192.0.2.1"],"enabled":true},{"id":43,"content":["192.0.2.3"],"enabled":true}]}`},
		dnstest.Exchange{Method: "PUT", Path: "/v2/zones/example.com/example.com/CNAME",
			JSON:     map[string]any{"ttl": 300, "resource_records": []any{map[string]any{"content": []any{"edge.example.net."}}}},
			Response: `{"name":"example.com","type":"CNAME","ttl":300,"resource_records":[{"id":44,"content":["edge.example.net."],"enabled":true}],"warnings":[{"key":"cname_on_apex","message":"..."}]}`},
	)
	set, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60), dnstest.A("www", "192.0.2.3", 60), dnstest.CNAME("@", "edge.example.net.", 300),
	})
	if err != nil || len(set) != 3 {
		t.Fatalf("set %v err %v", set, err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/v2/zones/example.com/www.example.com/A", Response: wwwA},
		dnstest.Exchange{Method: "PUT", Path: "/v2/zones/example.com/www.example.com/A",
			JSON: map[string]any{"ttl": 300, "pickers": []any{map[string]any{"type": "geodns"}}, "resource_records": []any{
				map[string]any{"content": []any{"192.0.2.1"}},
			}},
			Response: `{}`},
		dnstest.Exchange{Method: "GET", Path: "/v2/zones/example.com/_acme-challenge.example.com/TXT",
			Response: `{"name":"_acme-challenge.example.com","type":"TXT","ttl":60,"resource_records":[{"id":50,"content":["token-value"],"enabled":true}]}`},
		dnstest.Exchange{Method: "DELETE", Path: "/v2/zones/example.com/_acme-challenge.example.com/TXT", Header: headers, Response: `{}`},
		dnstest.Exchange{Method: "GET", Path: "/v2/zones/example.com/gone.example.com/AAAA", Status: 404, Response: `{"error":"record is not found"}`},
	)
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 0), libdns.RR{Name: "_acme-challenge", Type: "TXT"}, dnstest.AAAA("gone", "2001:db8::1", 0),
	})
	if err != nil || len(deleted) != 2 || !dnstest.Has(deleted, "www", "A", "192.0.2.2") || !dnstest.Has(deleted, "_acme-challenge", "TXT", "token-value") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{
		Method: "GET", Path: "/v2/zones", Header: headers, Query: map[string]string{"limit": "1000", "offset": "0"},
		Response: `{"zones":[{"name":"example.com","enabled":true,"status":"active"},{"name":"Example.NET","enabled":true}],"total_amount":2}`,
	})
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/v2/zones/example.com/rrsets", Status: 401,
			Response: `{"exception_class":"token_not_valid","message":"Bad permanent token: 7711$eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9","request_id":"af999e5f"}`},
		dnstest.Exchange{Method: "GET", Path: "/v2/zones/unknown.example/rrsets", Status: 404, Response: `{"error":"zone is not found"}`},
		dnstest.Exchange{Method: "GET", Path: "/v2/zones/example.com/rrsets", Status: 500, Response: `{"error":"internal error"}`},
		dnstest.Exchange{Method: "PUT", Path: "/v2/zones/example.com/example.com/CNAME", Status: 409, Response: `{"error":"cname can't coexists with other records"}`},
	)
	p := provider(t, s)
	_, err := p.GetRecords(context.Background(), "example.com.")
	dnstest.NoSecret(t, err, token, secret, "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9")
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("bad token: %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "unknown.example."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	_, err = p.SetRecords(context.Background(), "example.com.", []libdns.Record{dnstest.CNAME("@", "edge.example.net", 300)})
	if dnsx.Code(err) != "dns_provider_error" || !strings.Contains(err.Error(), "cname can't coexists") {
		t.Fatalf("conflict: %v", err)
	}
	for _, bad := range []string{"", "no-dollar", "7711$has space", "$secret", "abc$secret"} {
		if _, err := New(map[string]string{"api_key": bad}, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed token %q accepted: %v", bad, err)
		}
	}
	if _, err := p.SetRecords(context.Background(), "example.com.", []libdns.Record{libdns.RR{Name: "@", Type: "MX", Data: "10 mail.example.com"}}); !errors.Is(err, dnsx.ErrUnsupported) {
		t.Fatalf("MX write: %v", err)
	}
}
