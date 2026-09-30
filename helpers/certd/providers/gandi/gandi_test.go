package gandi

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Requests and responses follow the LiveDNS reference
// (https://api.gandi.net/docs/livedns/): "Domain's records", "Records with a
// specific name and type" and "Domains", with the error body of its 401/403
// responses (code, message, object, cause).
const token = "pat_0123456789abcdef-0123456789abcdef"

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	p, err := New(map[string]string{"bearer_token": token}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return p.(*Provider)
}

var auth = map[string]string{"Authorization": "Bearer " + token, "User-Agent": "edgeweir-certd/1"}

func get(path, response string) dnstest.Exchange {
	return dnstest.Exchange{Method: "GET", Path: "/domains/example.com/records/" + path, Header: auth, Response: response}
}

func missing(path string) dnstest.Exchange {
	return dnstest.Exchange{Method: "GET", Path: "/domains/example.com/records/" + path, Status: 404, Response: `{"code":404,"message":"The resource could not be found.","object":"HTTPNotFound","cause":"Not Found"}`}
}

func put(path string, json any) dnstest.Exchange {
	return dnstest.Exchange{Method: "PUT", Path: "/domains/example.com/records/" + path, Header: auth, JSON: json, Status: 201, Response: `{"message":"DNS Record Created"}`}
}

func TestGetRecordsFollowsPages(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{
			Method: "GET", Path: "/domains/example.com/records", Header: auth,
			Query:          map[string]string{"page": "1", "per_page": "500"},
			ResponseHeader: map[string]string{"Total-Count": "3"},
			Response: `[{"rrset_name":"@","rrset_ttl":10800,"rrset_type":"A","rrset_values":["192.0.2.1"],"rrset_href":"https://api.test/v5/livedns/domains/example.com/records/%40/A"},
				{"rrset_name":"www","rrset_ttl":10800,"rrset_type":"CNAME","rrset_values":["www.example.net."],"rrset_href":"https://api.test/v5/livedns/domains/example.com/records/www/CNAME"}]`,
		},
		dnstest.Exchange{
			Method: "GET", Path: "/domains/example.com/records",
			Query:          map[string]string{"page": "2", "per_page": "500"},
			ResponseHeader: map[string]string{"Total-Count": "3"},
			Response:       `[{"rrset_name":"_acme-challenge","rrset_ttl":300,"rrset_type":"TXT","rrset_values":["\"one\"","\"t\" \"wo\""],"rrset_href":"https://api.test/v5/livedns/domains/example.com/records/_acme-challenge/TXT"}]`,
		},
	)
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 4 || !dnstest.Has(records, "@", "A", "192.0.2.1") || !dnstest.Has(records, "www", "CNAME", "www.example.net") ||
		!dnstest.Has(records, "_acme-challenge", "TXT", "one") || !dnstest.Has(records, "_acme-challenge", "TXT", "two") {
		t.Fatalf("records: %+v", records)
	}
	if records[0].RR().TTL.Seconds() != 10800 {
		t.Fatalf("ttl: %v", records[0].RR().TTL)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		missing("_acme-challenge/TXT"),
		put("_acme-challenge/TXT", map[string]any{"rrset_values": []any{`"token"`}, "rrset_ttl": 300}),
		get("www/A", `{"rrset_name":"www","rrset_type":"A","rrset_values":["192.0.2.1"],"rrset_ttl":10800}`),
		// The existing member stays; the RRset keeps its TTL.
		put("www/A", map[string]any{"rrset_values": []any{"192.0.2.1", "192.0.2.7"}, "rrset_ttl": 10800}),
		missing("@/ALIAS"),
		put("@/ALIAS", map[string]any{"rrset_values": []any{"edge.example.net."}, "rrset_ttl": 600}),
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", "token", 60),
		dnstest.A("www", "192.0.2.7", 60), dnstest.A("www", "192.0.2.1", 60),
		libdns.RR{Name: "@", Type: "ALIAS", Data: "edge.example.net", TTL: 600 * time.Second},
	})
	if err != nil || len(done) != 4 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsPutsWholeRRsets(t *testing.T) {
	long := "v=DKIM1; p=" + strings.Repeat("A", 300)
	s := dnstest.Serve(t,
		// www A: 192.0.2.1 kept, 192.0.2.3 added, anything else dropped, TTL
		// set; cdn CNAME and a long TXT; no other RRset is touched.
		put("www/A", map[string]any{"rrset_values": []any{"192.0.2.1", "192.0.2.3"}, "rrset_ttl": 600}),
		put("cdn/CNAME", map[string]any{"rrset_values": []any{"edge.example.net."}, "rrset_ttl": 300}),
		put("dkim/TXT", map[string]any{"rrset_values": []any{`"` + long[:255] + `" "` + long[255:] + `"`}, "rrset_ttl": 300}),
	)
	_, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 600), dnstest.CNAME("cdn", "edge.example.net", 60), dnstest.A("WWW", "192.0.2.3", 60),
		dnstest.TXT("dkim", long, 60),
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		get("www/A", `{"rrset_name":"www","rrset_type":"A","rrset_values":["192.0.2.1","192.0.2.2"],"rrset_ttl":1200}`),
		put("www/A", map[string]any{"rrset_values": []any{"192.0.2.1"}, "rrset_ttl": 1200}),
		get("_acme-challenge/TXT", `{"rrset_name":"_acme-challenge","rrset_type":"TXT","rrset_values":["\"token\""],"rrset_ttl":300}`),
		dnstest.Exchange{Method: "DELETE", Path: "/domains/example.com/records/_acme-challenge/TXT", Header: auth, Status: 204},
		missing("gone/A"),
		get("old/AAAA", `{"rrset_name":"old","rrset_type":"AAAA","rrset_values":["2001:db8::1","2001:db8::2"],"rrset_ttl":300}`),
		dnstest.Exchange{Method: "DELETE", Path: "/domains/example.com/records/old/AAAA", Status: 204},
	)
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 60),
		dnstest.TXT("_acme-challenge", "token", 60),
		dnstest.A("gone", "192.0.2.9", 60),
		libdns.RR{Name: "old", Type: "AAAA"}, // whole RRset
	})
	if err != nil || len(deleted) != 4 || !dnstest.Has(deleted, "www", "A", "192.0.2.2") || !dnstest.Has(deleted, "_acme-challenge", "TXT", "token") || !dnstest.Has(deleted, "old", "AAAA", "2001:db8::2") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{
		Method: "GET", Path: "/domains", Header: auth, Query: map[string]string{"page": "1", "per_page": "500"},
		ResponseHeader: map[string]string{"Total-Count": "2"},
		Response: `[{"fqdn":"example.org","domain_href":"https://api.test/v5/livedns/domains/example.org","domain_records_href":"https://api.test/v5/livedns/domains/example.org/records"},
			{"fqdn":"Example.NET","domain_href":"https://api.test/v5/livedns/domains/example.net","domain_records_href":"https://api.test/v5/livedns/domains/example.net/records"}]`,
	})
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.org." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/records", Status: 401, Response: `{"code":401,"message":"The server could not verify that you are authorized to access the URL requested.","object":"HTTPUnauthorized","cause":"Unauthorized"}`},
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/records", Status: 403, Response: `{"code":403,"message":"Access was denied to this resource.","object":"HTTPForbidden","cause":"Forbidden"}`},
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/records", Status: 404, Response: `{"code":404,"message":"The resource could not be found.","object":"HTTPNotFound","cause":"Not Found"}`},
		dnstest.Exchange{Method: "GET", Path: "/domains/example.com/records", Status: 503, Response: `{"code":503,"message":"Service Unavailable","object":"HTTPServiceUnavailable","cause":"Service Unavailable"}`},
		missing("www/A"),
		dnstest.Exchange{Method: "PUT", Path: "/domains/example.com/records/www/A", Status: 404, Response: `{"code":404,"message":"The resource could not be found.","object":"HTTPNotFound","cause":"Not Found"}`},
	)
	p := provider(t, s)
	ctx := context.Background()
	for range 2 {
		_, err := p.GetRecords(ctx, "example.com.")
		dnstest.NoSecret(t, err, token)
		if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
			t.Fatalf("auth failure: %v", err)
		}
	}
	if _, err := p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err := p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	if _, err := p.AppendRecords(ctx, "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.1", 60)}); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("append to unknown zone: %v", err)
	}
	for _, bad := range []string{"", "short", token + " x", "Bearer " + token} {
		if _, err := New(map[string]string{"bearer_token": bad}, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed token accepted: %q", bad)
		}
	}
}
