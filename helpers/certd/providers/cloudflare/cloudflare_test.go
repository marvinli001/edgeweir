package cloudflare

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Responses follow the Cloudflare API reference and its OpenAPI schema
// (https://developers.cloudflare.com/api/resources/zones/methods/list/,
// https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/,
// https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/batch/).
const (
	token     = "YQSn-xWAQiiEh9qM58wZNnyQS7FUdoqGIUAbrh7T"
	zoneToken = "zT0kEn-0123456789abcdefghijklmnopqrstu_"
	zoneID    = "023e105f4ecef8ad9ca31a8372d0c353"
)

func provider(t *testing.T, s *dnstest.Server, fields map[string]string) *Provider {
	t.Helper()
	p, err := New(fields, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return p.(*Provider)
}

func tokens() map[string]string { return map[string]string{"api_token": token} }

func zoneLookup(bearer string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "GET", Path: "/zones",
		Query:  map[string]string{"name": "example.com"},
		Header: map[string]string{"Authorization": "Bearer " + bearer, "User-Agent": "edgeweir-certd/1"},
		Response: `{"success":true,"errors":[],"messages":[],"result":[
			{"id":"` + zoneID + `","name":"example.com","status":"active","type":"full","account":{"id":"023e105f4ecef8ad9ca31a8372d0c353","name":"Example Account Name"}}],
			"result_info":{"count":1,"page":1,"per_page":50,"total_count":1,"total_pages":1}}`,
	}
}

func listPage(page, totalPages int, records string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "GET", Path: "/zones/" + zoneID + "/dns_records",
		Query:    map[string]string{"page": fmt.Sprint(page), "per_page": "5000"},
		Header:   map[string]string{"Authorization": "Bearer " + token},
		Response: `{"success":true,"errors":[],"messages":[],"result":[` + records + `],"result_info":{"count":1,"page":` + fmt.Sprint(page) + `,"per_page":5000,"total_count":5,"total_pages":` + fmt.Sprint(totalPages) + `}}`,
	}
}

func rec(id, typ, name, content string, ttl int, proxied bool) string {
	return fmt.Sprintf(`{"id":%q,"type":%q,"name":%q,"content":%q,"ttl":%d,"proxied":%t,"proxiable":true,"comment":"","tags":[],"created_on":"2014-01-01T05:20:00.12345Z","modified_on":"2014-01-01T05:20:00.12345Z","meta":{}}`, id, typ, name, content, ttl, proxied)
}

var existing = rec("a1", "A", "www.example.com", "192.0.2.1", 300, false) + "," +
	rec("a2", "A", "www.example.com", "192.0.2.2", 300, false) + "," +
	rec("c1", "CNAME", "cdn.example.com", "edge.example.net", 1, true) + "," +
	rec("t1", "TXT", "example.com", `"keep"`, 3600, false) + "," +
	rec("t2", "TXT", "_acme-challenge.example.com", `"a" "b"`, 60, false)

func batchCall(json any, result string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "POST", Path: "/zones/" + zoneID + "/dns_records/batch",
		Header:   map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/json"},
		JSON:     json,
		Response: `{"success":true,"errors":[],"messages":[],"result":` + result + `}`,
	}
}

func TestGetRecordsFollowsPages(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(token),
		listPage(1, 2, rec("a1", "A", "www.example.com", "192.0.2.1", 300, false)+","+rec("t1", "TXT", "example.com", `"v=spf1 -all"`, 1, false)),
		listPage(2, 2, rec("c1", "CNAME", "cdn.example.com", "edge.example.net", 120, false)+`,{"id":"m1","type":"MX","name":"example.com","content":"mail.example.com","priority":10,"ttl":3600}`),
	)
	records, err := provider(t, s, tokens()).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 4 || !dnstest.Has(records, "www", "A", "192.0.2.1") || !dnstest.Has(records, "@", "TXT", "v=spf1 -all") ||
		!dnstest.Has(records, "cdn", "CNAME", "edge.example.net") || !dnstest.Has(records, "@", "MX", "10 mail.example.com") {
		t.Fatalf("records: %+v", records)
	}
	if ttl := records[1].RR().TTL.Seconds(); ttl != 300 {
		t.Fatalf("automatic TTL served as %v", ttl)
	}
}

func TestZoneTokenLooksUpTheZone(t *testing.T) {
	s := dnstest.Serve(t, zoneLookup(zoneToken), listPage(1, 1, ""))
	p := provider(t, s, map[string]string{"api_token": token, "zone_token": zoneToken})
	if _, err := p.GetRecords(context.Background(), "example.com."); err != nil {
		t.Fatal(err)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(token),
		batchCall(map[string]any{"posts": []any{
			map[string]any{"type": "TXT", "name": "_acme-challenge.example.com", "content": `"token \"q\""`, "ttl": 60},
			map[string]any{"type": "CNAME", "name": "example.com", "content": "edge.example.net", "ttl": 60, "proxied": false},
		}}, `{"posts":[`+rec("n1", "TXT", "_acme-challenge.example.com", `"token \"q\""`, 60, false)+","+rec("n2", "CNAME", "example.com", "edge.example.net", 60, false)+`]}`),
	)
	done, err := provider(t, s, tokens()).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", `token "q"`, 30), dnstest.CNAME("@", "edge.example.net.", 60),
	})
	if err != nil || len(done) != 2 || !dnstest.Has(done, "_acme-challenge", "TXT", `token "q"`) || !dnstest.Has(done, "@", "CNAME", "edge.example.net") {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsReplacesTheRRsetInOneBatch(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(token),
		listPage(1, 1, existing),
		// www: 192.0.2.1 stays with a new TTL, 192.0.2.2 goes, 192.0.2.3 is created;
		// cdn: the proxied member becomes DNS only; the TXT RRsets are untouched.
		batchCall(map[string]any{
			"deletes": []any{map[string]any{"id": "a2"}},
			"patches": []any{map[string]any{"id": "a1", "ttl": 60}, map[string]any{"id": "c1", "ttl": 60, "proxied": false}},
			"posts":   []any{map[string]any{"type": "A", "name": "www.example.com", "content": "192.0.2.3", "ttl": 60, "proxied": false}},
		}, `{"deletes":[`+rec("a2", "A", "www.example.com", "192.0.2.2", 300, false)+`],"patches":[],"posts":[]}`),
	)
	_, err := provider(t, s, tokens()).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("WWW", "192.0.2.3", 60), dnstest.CNAME("cdn", "Edge.Example.NET.", 60),
	})
	if err != nil {
		t.Fatal(err)
	}
	body := string(s.Requests[2].Body)
	for _, key := range []string{`"t1"`, `"t2"`, `"puts"`} {
		if strings.Contains(body, key) {
			t.Fatalf("batch touches %s: %s", key, body)
		}
	}
	if !strings.Contains(body, `{"id":"a1","ttl":60}`) {
		t.Fatalf("DNS-only member patched beyond its TTL: %s", body)
	}
}

func TestSetRecordsUnchangedSendsNothing(t *testing.T) {
	s := dnstest.Serve(t, zoneLookup(token), listPage(1, 1, existing))
	_, err := provider(t, s, tokens()).SetRecords(context.Background(), "example.com.", []libdns.Record{dnstest.TXT("@", "keep", 3600)})
	if err != nil {
		t.Fatal(err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(token),
		listPage(1, 1, existing),
		batchCall(map[string]any{"deletes": []any{map[string]any{"id": "a2"}, map[string]any{"id": "t2"}}}, `{"deletes":[]}`),
	)
	deleted, err := provider(t, s, tokens()).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 60),
		libdns.RR{Name: "_acme-challenge", Type: "TXT"}, // whole RRset
		dnstest.A("www", "192.0.2.9", 60),               // absent: ignored
	})
	if err != nil || len(deleted) != 2 || !dnstest.Has(deleted, "www", "A", "192.0.2.2") || !dnstest.Has(deleted, "_acme-challenge", "TXT", "ab") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	page := func(n int, names ...string) dnstest.Exchange {
		items := ""
		for i, name := range names {
			if i > 0 {
				items += ","
			}
			items += fmt.Sprintf(`{"id":"z%d","name":%q,"status":"active"}`, i, name)
		}
		return dnstest.Exchange{
			Method: "GET", Path: "/zones", Query: map[string]string{"page": fmt.Sprint(n), "per_page": "50", "name": ""},
			Header:   map[string]string{"Authorization": "Bearer " + zoneToken},
			Response: `{"success":true,"errors":[],"messages":[],"result":[` + items + `],"result_info":{"count":1,"page":` + fmt.Sprint(n) + `,"per_page":50,"total_count":3,"total_pages":2}}`,
		}
	}
	s := dnstest.Serve(t, page(1, "example.com", "Example.NET"), page(2, "example.org"))
	zones, err := provider(t, s, map[string]string{"api_token": token, "zone_token": zoneToken}).ListZones(context.Background())
	if err != nil || len(zones) != 3 || zones[0].Name != "example.com." || zones[1].Name != "example.net." || zones[2].Name != "example.org." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/zones", Status: 403, Response: `{"success":false,"errors":[{"code":9109,"message":"Invalid access token"}],"messages":[],"result":null}`},
		dnstest.Exchange{Method: "GET", Path: "/zones", Status: 400, Response: `{"success":false,"errors":[{"code":6003,"message":"Invalid request headers","error_chain":[{"code":6111,"message":"Invalid format for Authorization header"}]}],"messages":[],"result":null}`},
		dnstest.Exchange{Method: "GET", Path: "/zones", Response: `{"success":true,"errors":[],"messages":[],"result":[],"result_info":{"count":0,"page":1,"per_page":50,"total_count":0,"total_pages":0}}`},
		zoneLookup(token),
		dnstest.Exchange{Method: "GET", Path: "/zones/" + zoneID + "/dns_records", Status: 502, Response: `<html>bad gateway</html>`},
		listPage(1, 1, existing),
		dnstest.Exchange{Method: "POST", Path: "/zones/" + zoneID + "/dns_records/batch", Status: 429, Response: `{"success":false,"errors":[{"code":971,"message":"Please wait and consider throttling your request speed"}],"messages":[],"result":null}`},
	)
	p := provider(t, s, tokens())
	ctx := context.Background()
	_, err := p.GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, token)
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("invalid token: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrAuth) {
		t.Fatalf("malformed Authorization header: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	_, err = p.GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, token)
	if dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	if _, err = p.DeleteRecords(ctx, "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.1", 60)}); dnsx.Code(err) != "dns_rate_limited" {
		t.Fatalf("429: %v", err)
	}
	for _, fields := range []map[string]string{{"api_token": ""}, {"api_token": "short"}, {"api_token": token + " x"}, {"api_token": token, "zone_token": "bad\ntoken-0123456789abcdef"}} {
		if _, err := New(fields, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed credentials accepted: %q", fields)
		}
	}
}
