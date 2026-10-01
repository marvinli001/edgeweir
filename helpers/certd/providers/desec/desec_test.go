package desec

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Bodies follow the deSEC API documentation
// (https://desec.readthedocs.io/en/latest/dns/rrsets.html: RRset field
// reference, pagination, bulk modification; .../dns/domains.html: domain
// object with minimum_ttl; .../rate-limits.html: 429 with Retry-After).
const token = "mu4W4MHuSc0Hy-GD1h_dnKuZBond"

var headers = map[string]string{"Authorization": "Token " + token, "User-Agent": "edgeweir-certd/1", "Accept": "application/json"}

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	p, err := New(map[string]string{"token": token}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	pr := p.(*Provider)
	pr.sleep = func(context.Context, time.Duration) error { t.Fatal("unexpected wait"); return nil }
	return pr
}

// cursor asserts the cursor query parameter (present, possibly empty).
func cursor(want string) func(t *testing.T, r *http.Request, _ []byte) {
	return func(t *testing.T, r *http.Request, _ []byte) {
		if got, ok := r.URL.Query()["cursor"]; !ok || got[0] != want {
			t.Errorf("cursor %q, want %q", got, want)
		}
	}
}

func set(subname, typ string, ttl string, records string) string {
	name := subname + ".example.com."
	if subname == "" {
		name = "example.com."
	}
	return `{"created":"2019-09-18T16:32:16.510368Z","domain":"example.com","subname":"` + subname + `","name":"` + name +
		`","type":"` + typ + `","records":[` + records + `],"ttl":` + ttl + `,"touched":"2020-04-06T09:24:09.987436Z"}`
}

var domain = func(minimum string) dnstest.Exchange {
	return dnstest.Exchange{Method: "GET", Path: "/domains/example.com/", Header: headers,
		Response: `{"created":"2018-09-18T16:36:16.510368Z","keys":[],"minimum_ttl":` + minimum + `,"name":"example.com","published":"2018-09-18T17:21:38.348112Z","touched":"2018-09-18T17:21:38.348112Z"}`}
}

var wwwA = set("www", "A", "3600", `"192.0.2.1","192.0.2.2"`)

func TestGetRecordsPages(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/rrsets/", Header: headers, Check: cursor(""),
			ResponseHeader: map[string]string{"Link": `<https://desec.io/api/v1/domains/example.com/rrsets/?cursor=>; rel="first", <https://desec.io/api/v1/domains/example.com/rrsets/?cursor=:next_cursor>; rel="next"`},
			Response:       `[` + wwwA + `,` + set("", "NS", "3600", `"ns1.desec.io.","ns2.desec.org."`) + `]`},
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/rrsets/", Check: cursor(":next_cursor"),
			ResponseHeader: map[string]string{"Link": `<https://desec.io/api/v1/domains/example.com/rrsets/?cursor=>; rel="first", <https://desec.io/api/v1/domains/example.com/rrsets/?cursor=:prev_cursor>; rel="prev"`},
			Response: `[` + set("", "TXT", "3600", `"\"v=spf1 -all\"","\"a\\\"b\" \"c\\\\d\\100\""`) + `,` +
				set("cdn", "CNAME", "3600", `"edge.example.net."`) + `]`},
	)
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 7 || !dnstest.Has(records, "www", "A", "192.0.2.2") || !dnstest.Has(records, "@", "NS", "ns1.desec.io.") ||
		!dnstest.Has(records, "@", "TXT", "v=spf1 -all") || !dnstest.Has(records, "@", "TXT", `a"bc\dd`) || !dnstest.Has(records, "cdn", "CNAME", "edge.example.net") {
		t.Fatalf("records: %+v", records)
	}
	if ttl := records[0].RR().TTL.Seconds(); ttl != 3600 {
		t.Fatalf("ttl %v", ttl)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		domain("3600"),
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/rrsets/www/A/", Header: headers, Response: wwwA},
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/rrsets/_acme-challenge/TXT/", Status: 404, Response: `{"detail":"Not found."}`},
		// One bulk write: the existing RRset keeps its members and TTL, the new
		// one gets the domain's minimum TTL.
		dnstest.Exchange{Method: "PUT", Path: "/domains/example.com/rrsets/", Header: map[string]string{"Authorization": "Token " + token, "Content-Type": "application/json"},
			JSON: []any{
				map[string]any{"subname": "www", "type": "A", "ttl": 3600, "records": []any{"192.0.2.1", "192.0.2.2", "192.0.2.3"}},
				map[string]any{"subname": "_acme-challenge", "type": "TXT", "ttl": 3600, "records": []any{`"token-value"`}},
			},
			Response: `[` + set("www", "A", "3600", `"192.0.2.1","192.0.2.2","192.0.2.3"`) + `,` + set("_acme-challenge", "TXT", "3600", `"\"token-value\""`) + `]`},
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.3", 60), dnstest.A("www", "192.0.2.1", 60), dnstest.TXT("_acme-challenge", "token-value", 60),
	})
	if err != nil || len(done) != 2 || done[1].RR().TTL.Seconds() != 3600 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestAppendRecordsAlreadyPresent(t *testing.T) {
	s := dnstest.Serve(t,
		domain("3600"),
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/rrsets/www/A/", Response: wwwA},
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.1", 60)})
	if err != nil || len(done) != 0 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsPutsWholeRRsets(t *testing.T) {
	s := dnstest.Serve(t,
		domain("60"), // a domain with a lowered minimum TTL
		// www A becomes exactly {192.0.2.1, 192.0.2.3} (192.0.2.2 goes, TTL
		// 3600 -> 60); the CNAME gets its trailing dot; nothing else is sent.
		dnstest.Exchange{Method: "PUT", Path: "/domains/example.com/rrsets/", Header: headers,
			JSON: []any{
				map[string]any{"subname": "www", "type": "A", "ttl": 60, "records": []any{"192.0.2.1", "192.0.2.3"}},
				map[string]any{"subname": "cdn", "type": "CNAME", "ttl": 300, "records": []any{"edge.example.net."}},
			},
			Response: `[]`},
	)
	done, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60), dnstest.CNAME("cdn", "edge.example.net", 300),
	})
	if err != nil || len(done) != 3 || done[0].RR().TTL.Seconds() != 60 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsRaisesTheTTLToTheDomainMinimum(t *testing.T) {
	s := dnstest.Serve(t,
		domain("3600"),
		dnstest.Exchange{Method: "PUT", Path: "/domains/example.com/rrsets/",
			JSON:     []any{map[string]any{"subname": "", "type": "TXT", "ttl": 3600, "records": []any{`"keep"`}}},
			Response: `[]`},
	)
	done, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{dnstest.TXT("@", "keep", 60)})
	if err != nil || len(done) != 1 || done[0].RR().TTL.Seconds() != 3600 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/rrsets/www/A/", Response: wwwA},
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/rrsets/_acme-challenge/TXT/",
			Response: set("_acme-challenge", "TXT", "3600", `"\"one\"","\"two\""`)},
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/rrsets/@/AAAA/", Status: 404, Response: `{"detail":"Not found."}`},
		dnstest.Exchange{Method: "PUT", Path: "/domains/example.com/rrsets/", Header: headers,
			JSON: []any{
				map[string]any{"subname": "www", "type": "A", "ttl": 3600, "records": []any{"192.0.2.1"}},
				map[string]any{"subname": "_acme-challenge", "type": "TXT", "ttl": 3600, "records": []any{}},
			},
			Response: `[]`},
	)
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 0), libdns.RR{Name: "_acme-challenge", Type: "TXT"}, dnstest.AAAA("@", "2001:db8::1", 0),
	})
	if err != nil || len(deleted) != 3 || !dnstest.Has(deleted, "_acme-challenge", "TXT", "two") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{Method: "GET", Path: "/domains/", Header: headers, Check: cursor(""),
		Response: `[{"created":"2018-09-18T16:36:16.510368Z","minimum_ttl":3600,"name":"example.com","published":"2018-09-18T17:21:38.348112Z","touched":"2018-09-18T17:21:38.348112Z"},{"name":"Example.NET","minimum_ttl":3600}]`})
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestRateLimit(t *testing.T) {
	throttled := func(after string) dnstest.Exchange {
		return dnstest.Exchange{Method: "GET", Path: "/domains/", Status: 429, ResponseHeader: map[string]string{"Retry-After": after},
			Response: `{"detail":"Request was throttled. Expected available in ` + after + ` seconds."}`}
	}
	s := dnstest.Serve(t,
		throttled("1"),
		dnstest.Exchange{Method: "GET", Path: "/domains/", Response: `[{"name":"example.com"}]`},
		throttled("60"),
	)
	p := provider(t, s)
	var waited []time.Duration
	p.sleep = func(_ context.Context, d time.Duration) error { waited = append(waited, d); return nil }
	if zones, err := p.ListZones(context.Background()); err != nil || len(zones) != 1 || len(waited) != 1 || waited[0] != time.Second {
		t.Fatalf("short throttle: zones %v err %v waited %v", zones, err, waited)
	}
	_, err := p.ListZones(context.Background())
	if !errors.Is(err, dnsx.ErrRateLimited) || len(waited) != 1 || !strings.Contains(err.Error(), "retry after 60 s") {
		t.Fatalf("long throttle: %v waited %v", err, waited)
	}
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/rrsets/", Status: 401, Response: `{"detail":"Invalid token."}`},
		dnstest.Exchange{Method: "GET", Path: "/domains/unknown.example/rrsets/", Status: 404, Response: `{"detail":"Not found."}`},
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/rrsets/", Status: 503, Response: `<html>unavailable</html>`},
		domain("3600"),
		dnstest.Exchange{Method: "PUT", Path: "/domains/example.com/rrsets/", Status: 400,
			Response: `[{"records":["Record content malformed: 192.0.2.300"]}]`},
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/", Status: 403, Response: `{"detail":"Insufficient token permissions."}`},
	)
	p := provider(t, s)
	_, err := p.GetRecords(context.Background(), "example.com.")
	dnstest.NoSecret(t, err, token)
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("invalid token: %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "unknown.example."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	_, err = p.SetRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.300", 3600)})
	if dnsx.Code(err) != "dns_provider_error" || !strings.Contains(err.Error(), "Record content malformed") {
		t.Fatalf("validation: %v", err)
	}
	if _, err = p.SetRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.1", 3600)}); !errors.Is(err, dnsx.ErrAuth) {
		t.Fatalf("policy refusal: %v", err)
	}
	for _, bad := range []string{"", "short", "has space in the token", "token+with/base64="} {
		if _, err := New(map[string]string{"token": bad}, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed token %q accepted: %v", bad, err)
		}
	}
	if _, err := p.SetRecords(context.Background(), "example.com.", []libdns.Record{libdns.RR{Name: "@", Type: "MX", Data: "10 mail.example.com."}}); !errors.Is(err, dnsx.ErrUnsupported) {
		t.Fatalf("MX write: %v", err)
	}
}

func TestTXTQuoting(t *testing.T) {
	long := strings.Repeat("x", 300)
	if got := quote(long); got != `"`+strings.Repeat("x", 255)+`" "`+strings.Repeat("x", 45)+`"` {
		t.Fatalf("split: %s", got)
	}
	for _, text := range []string{"", `a"b\c`, long, strings.Repeat("é", 200)} {
		if got := unquote(quote(text)); got != text {
			t.Fatalf("round trip %q -> %q", text, got)
		}
	}
	if got := quote(strings.Repeat("é", 200)); strings.Count(got, `"`) != 4 {
		t.Fatalf("multi-byte split: %s", got)
	}
}
