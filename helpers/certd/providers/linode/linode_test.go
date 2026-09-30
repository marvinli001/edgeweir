package linode

// Responses follow the examples of the Linode API v4 reference
// (https://techdocs.akamai.com/linode-api/reference/get-domains,
// get-domain-records, post-domain-record, put-domain-record,
// delete-domain-record, https://techdocs.akamai.com/linode-api/reference/errors).

import (
	"context"
	"errors"
	"testing"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

var auth = map[string]string{"Authorization": "Bearer " + token, "User-Agent": "edgeweir-certd/1"}

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	p, err := New(map[string]string{"api_token": token}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return p.(*Provider)
}

const domainJSON = `{"axfr_ips":[],"description":null,"domain":"example.com","expire_sec":300,"group":null,"id":1234,"master_ips":[],"refresh_sec":300,"retry_sec":300,"soa_email":"admin@example.com","status":"active","tags":[],"ttl_sec":3600,"type":"master"}`

func findCall() dnstest.Exchange {
	return dnstest.Exchange{
		Method: "GET", Path: "/v4/domains",
		Query:    map[string]string{"page": "1", "page_size": "500"},
		Header:   map[string]string{"Authorization": "Bearer " + token, "User-Agent": "edgeweir-certd/1", "X-Filter": `{"domain":"example.com"}`},
		Response: `{"data":[` + domainJSON + `],"page":1,"pages":1,"results":1}`,
	}
}

func recordsCall(page, pages, records string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "GET", Path: "/v4/domains/1234/records",
		Query:    map[string]string{"page": page, "page_size": "500"},
		Header:   map[string]string{"Authorization": "Bearer " + token, "X-Filter": ""},
		Response: `{"data":[` + records + `],"page":` + page + `,"pages":` + pages + `,"results":5}`,
	}
}

func rec(id, typ, name, target string, ttl string) string {
	return `{"created":"2018-01-01T00:01:01","id":` + id + `,"name":"` + name + `","port":0,"priority":0,"protocol":null,"service":null,"tag":null,"target":"` + target + `","ttl_sec":` + ttl + `,"type":"` + typ + `","updated":"2018-01-01T00:01:01","weight":0}`
}

var existing = rec("10", "A", "www", "192.0.2.1", "300") + "," + rec("11", "A", "www", "192.0.2.2", "300") + "," +
	rec("12", "TXT", "", "keep", "0") + "," + rec("13", "AAAA", "www", "2001:db8::1", "300")

func TestGetRecordsPaginates(t *testing.T) {
	s := dnstest.Serve(t,
		findCall(),
		recordsCall("1", "2", existing),
		recordsCall("2", "2", rec("14", "CNAME", "cdn", "edge.example.net", "3600")),
	)
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 5 || !dnstest.Has(records, "www", "A", "192.0.2.1") || !dnstest.Has(records, "@", "TXT", "keep") ||
		!dnstest.Has(records, "cdn", "CNAME", "edge.example.net") {
		t.Fatalf("records: %+v", records)
	}
	// ttl_sec 0 is the domain default.
	if records[0].RR().TTL.Seconds() != 300 || records[2].RR().TTL.Seconds() != 3600 {
		t.Fatalf("ttl: %v %v", records[0].RR().TTL, records[2].RR().TTL)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		findCall(),
		dnstest.Exchange{
			Method: "POST", Path: "/v4/domains/1234/records", Header: auth,
			// 60 s is rounded to the nearest accepted value.
			JSON:     map[string]any{"type": "TXT", "name": "", "target": "token-value", "ttl_sec": 300},
			Response: rec("20", "TXT", "", "token-value", "300"),
		},
		dnstest.Exchange{
			Method: "POST", Path: "/v4/domains/1234/records", Header: auth,
			JSON:     map[string]any{"type": "CNAME", "name": "cdn", "target": "edge.example.net.", "ttl_sec": 3600},
			Response: rec("21", "CNAME", "cdn", "edge.example.net", "3600"),
		},
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("@", "token-value", 60), dnstest.CNAME("cdn", "edge.example.net", 3000),
	})
	if err != nil || len(done) != 2 || done[0].RR().TTL.Seconds() != 300 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsReplacesTheRRset(t *testing.T) {
	s := dnstest.Serve(t,
		findCall(),
		recordsCall("1", "1", existing),
		// 192.0.2.1 stays with a new TTL, 192.0.2.2 goes, 192.0.2.3 is created; TXT and AAAA are untouched.
		dnstest.Exchange{
			Method: "PUT", Path: "/v4/domains/1234/records/10", Header: auth,
			Body:     `{"ttl_sec":3600}`,
			Response: rec("10", "A", "www", "192.0.2.1", "3600"),
		},
		dnstest.Exchange{Method: "DELETE", Path: "/v4/domains/1234/records/11", Header: auth, Response: `{}`},
		dnstest.Exchange{
			Method: "POST", Path: "/v4/domains/1234/records",
			JSON:     map[string]any{"type": "A", "name": "www", "target": "192.0.2.3", "ttl_sec": 3600},
			Response: rec("15", "A", "www", "192.0.2.3", "3600"),
		},
	)
	set, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 3600), dnstest.A("www", "192.0.2.3", 3600),
	})
	if err != nil || len(set) != 2 {
		t.Fatalf("set %v err %v", set, err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		findCall(),
		recordsCall("1", "1", existing),
		dnstest.Exchange{Method: "DELETE", Path: "/v4/domains/1234/records/10", Header: auth, Response: `{}`},
		dnstest.Exchange{Method: "DELETE", Path: "/v4/domains/1234/records/11", Header: auth, Response: `{}`},
	)
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{libdns.RR{Name: "www", Type: "A"}})
	if err != nil || len(deleted) != 2 || !dnstest.Has(deleted, "www", "A", "192.0.2.2") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{
			Method: "GET", Path: "/v4/domains", Query: map[string]string{"page": "1", "page_size": "500"},
			Header:   map[string]string{"Authorization": "Bearer " + token, "X-Filter": ""},
			Response: `{"data":[` + domainJSON + `],"page":1,"pages":2,"results":2}`,
		},
		dnstest.Exchange{
			Method: "GET", Path: "/v4/domains", Query: map[string]string{"page": "2", "page_size": "500"},
			Response: `{"data":[{"domain":"Example.NET","id":1235,"ttl_sec":0,"type":"master","status":"active"}],"page":2,"pages":2,"results":2}`,
		},
	)
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/v4/domains", Status: 401, Response: `{"errors":[{"reason":"Invalid Token"}]}`},
		// A token without the Domains scope.
		dnstest.Exchange{Method: "GET", Path: "/v4/domains", Status: 403, Response: `{"errors":[{"reason":"Your OAuth token is not authorized to use this endpoint."}]}`},
		// The filter finds nothing: the zone is not in this account.
		dnstest.Exchange{Method: "GET", Path: "/v4/domains", Response: `{"data":[],"page":1,"pages":0,"results":0}`},
		findCall(),
		dnstest.Exchange{Method: "GET", Path: "/v4/domains/1234/records", Status: 429, Response: `{"errors":[{"reason":"Too Many Requests"}]}`},
		findCall(),
		dnstest.Exchange{Method: "GET", Path: "/v4/domains/1234/records", Status: 500, Response: `{"errors":[{"reason":"Please try again"}]}`},
		findCall(),
		dnstest.Exchange{Method: "POST", Path: "/v4/domains/1234/records", Status: 400, Response: `{"errors":[{"field":"target","reason":"Invalid target"}]}`},
	)
	p := provider(t, s)
	ctx := context.Background()
	_, err := p.GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, token)
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("401: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("403: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_rate_limited" {
		t.Fatalf("429: %v", err)
	}
	_, err = p.GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, token)
	if dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	_, err = p.AppendRecords(ctx, "example.com.", []libdns.Record{dnstest.CNAME("x", "bad target", 300)})
	if dnsx.Code(err) != "dns_provider_error" || err.Error() != "HTTP 400: target: Invalid target" {
		t.Fatalf("400: %v", err)
	}
	for _, bad := range []string{"", "short", "0123456789abcdef 0123456789abcdef", "0123456789abcdef0123456789abcdef\x00"} {
		if _, err := New(map[string]string{"api_token": bad}, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed token %q accepted: %v", bad, err)
		}
	}
}

func TestTTLRounding(t *testing.T) {
	for in, want := range map[int]int{1: 300, 60: 300, 300: 300, 1900: 300, 2000: 3600, 5000: 3600, 6000: 7200, 5000000: 2419200} {
		if got := ttlOf(dnstest.A("x", "192.0.2.1", in).RR()); got != want {
			t.Fatalf("ttl %d -> %d, want %d", in, got, want)
		}
	}
}
