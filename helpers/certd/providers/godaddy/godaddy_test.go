package godaddy

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

// Requests and responses follow the Domains v1 reference
// (https://developer.godaddy.com/docs/references/rest/domains/v1/manage-dns,
// https://developer.godaddy.com/docs/api-users/pagination) and the error
// envelope of https://developer.godaddy.com/docs/api-users/errors.
const (
	apiKey    = "e4hN3Y4pDXEA_Xx1N6bSqjTHsQNp6SUzN9m"
	apiSecret = "Xx1N6bSqjTHs7z5bQ4WJoT"
	pat       = "gdpat.eyJhbGciOiJIUzI1NiJ9.c2NvcGVz.c2lnbmF0dXJl"
)

var auth = map[string]string{"Authorization": "sso-key " + apiKey + ":" + apiSecret, "User-Agent": "edgeweir-certd/1"}

func provider(t *testing.T, s *dnstest.Server, token string) *Provider {
	t.Helper()
	p, err := New(map[string]string{"api_token": token}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return p.(*Provider)
}

func keyProvider(t *testing.T, s *dnstest.Server) *Provider {
	return provider(t, s, apiKey+":"+apiSecret)
}

func records(n int) string {
	items := make([]string, n)
	for i := range items {
		items[i] = fmt.Sprintf(`{"data":"192.0.2.%d","name":"host%d","ttl":600,"type":"A"}`, i%250, i)
	}
	return "[" + strings.Join(items, ",") + "]"
}

func TestGetRecordsFollowsPages(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/v1/domains/example.com/records", Header: auth, Query: map[string]string{"limit": "500", "offset": ""}, Response: records(500)},
		dnstest.Exchange{Method: "GET", Path: "/v1/domains/example.com/records", Header: auth, Query: map[string]string{"limit": "500", "offset": "2"},
			Response: `[{"data":"\"v=spf1 -all\"","name":"@","ttl":3600,"type":"TXT"},{"data":"mail.example.com","name":"@","priority":10,"ttl":3600,"type":"MX"},{"data":"edge.example.net","name":"cdn","ttl":600,"type":"CNAME"}]`},
	)
	got, err := keyProvider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 503 || !dnstest.Has(got, "host499", "A", "192.0.2.249") || !dnstest.Has(got, "@", "TXT", "v=spf1 -all") ||
		!dnstest.Has(got, "@", "MX", "10 mail.example.com") || !dnstest.Has(got, "cdn", "CNAME", "edge.example.net") {
		t.Fatalf("records: %d", len(got))
	}
}

func TestGetRecordsPastTheLastPage(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/v1/domains/example.com/records", Response: records(500)},
		dnstest.Exchange{Method: "GET", Path: "/v1/domains/example.com/records", Query: map[string]string{"offset": "2"}, Status: 422, Response: `{"code":"INVALID_BODY","message":"offset out of range"}`},
	)
	got, err := keyProvider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil || len(got) != 500 {
		t.Fatalf("records %d err %v", len(got), err)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{
		Method: "PATCH", Path: "/v1/domains/example.com/records", Header: map[string]string{"Authorization": "Bearer " + pat, "Content-Type": "application/json"},
		JSON: []any{
			map[string]any{"type": "TXT", "name": "_acme-challenge", "data": "token", "ttl": 600},
			map[string]any{"type": "CNAME", "name": "cdn", "data": "edge.example.net", "ttl": 3600},
		},
	})
	done, err := provider(t, s, pat).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", "token", 60), dnstest.CNAME("cdn", "edge.example.net.", 3600),
	})
	if err != nil || len(done) != 2 || done[0].RR().TTL.Seconds() != 600 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsPutsWholeRRsets(t *testing.T) {
	s := dnstest.Serve(t,
		// www A becomes exactly 192.0.2.1 and 192.0.2.3 (members not listed are
		// dropped by the PUT); no other RRset is touched.
		dnstest.Exchange{Method: "PUT", Path: "/v1/domains/example.com/records/A/www", Header: auth,
			JSON: []any{map[string]any{"data": "192.0.2.1", "ttl": 600}, map[string]any{"data": "192.0.2.3", "ttl": 600}}},
		dnstest.Exchange{Method: "PUT", Path: "/v1/domains/example.com/records/TXT/@", Header: auth,
			JSON: []any{map[string]any{"data": "keep", "ttl": 3600}}},
	)
	_, err := keyProvider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.TXT("@", "keep", 3600), dnstest.A("WWW", "192.0.2.3", 60), dnstest.A("www", "192.0.2.1", 60),
	})
	if err != nil {
		t.Fatal(err)
	}
	if body := string(s.Requests[0].Body); strings.Contains(body, `"name"`) || strings.Contains(body, `"type"`) {
		t.Fatalf("RRset body carries name/type: %s", body)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/v1/domains/example.com/records/A/www", Header: auth,
			Response: `[{"data":"192.0.2.1","name":"www","ttl":600,"type":"A"},{"data":"192.0.2.2","name":"www","ttl":1200,"type":"A"}]`},
		dnstest.Exchange{Method: "PUT", Path: "/v1/domains/example.com/records/A/www", JSON: []any{map[string]any{"data": "192.0.2.1", "ttl": 600}}},
		dnstest.Exchange{Method: "GET", Path: "/v1/domains/example.com/records/TXT/_acme-challenge",
			Response: `[{"data":"token","name":"_acme-challenge","ttl":600,"type":"TXT"}]`},
		dnstest.Exchange{Method: "DELETE", Path: "/v1/domains/example.com/records/TXT/_acme-challenge", Header: auth, Status: 204},
		dnstest.Exchange{Method: "GET", Path: "/v1/domains/example.com/records/A/gone", Response: `[]`},
	)
	deleted, err := keyProvider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 60),
		libdns.RR{Name: "_acme-challenge", Type: "TXT"}, // whole RRset
		dnstest.A("gone", "192.0.2.9", 60),
	})
	if err != nil || len(deleted) != 2 || !dnstest.Has(deleted, "www", "A", "192.0.2.2") || !dnstest.Has(deleted, "_acme-challenge", "TXT", "token") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZonesFollowsTheMarker(t *testing.T) {
	first := make([]string, 500)
	for i := range first {
		first[i] = fmt.Sprintf(`{"domain":"example%03d.com","domainId":%d,"status":"ACTIVE"}`, i, i)
	}
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/v1/domains", Header: auth, Query: map[string]string{"limit": "500", "marker": ""}, Response: "[" + strings.Join(first, ",") + "]"},
		dnstest.Exchange{Method: "GET", Path: "/v1/domains", Query: map[string]string{"limit": "500", "marker": "example499.com"}, Response: `[{"domain":"Example.NET","domainId":500,"status":"ACTIVE"}]`},
	)
	zones, err := keyProvider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 501 || zones[0].Name != "example000.com." || zones[500].Name != "example.net." {
		t.Fatalf("zones %d err %v", len(zones), err)
	}
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/v1/domains/example.com/records", Status: 401, Response: `{"code":"UNABLE_TO_AUTHENTICATE","message":"Unauthorized : Could not authenticate API key/secret"}`},
		dnstest.Exchange{Method: "GET", Path: "/v1/domains/example.com/records", Status: 403, Response: `{"code":"ACCESS_DENIED","message":"Authenticated user is not allowed access"}`},
		dnstest.Exchange{Method: "GET", Path: "/v1/domains/example.com/records", Status: 404, Response: `{"code":"UNKNOWN_DOMAIN","message":"The given domain is not registered, or does not have a zone file"}`},
		dnstest.Exchange{Method: "GET", Path: "/v1/domains/example.com/records", Status: 500, Response: `{"code":"INTERNAL_SERVER_ERROR","message":"Internal server error"}`},
		dnstest.Exchange{Method: "PUT", Path: "/v1/domains/example.com/records/A/www", Status: 429, Response: `{"code":"TOO_MANY_REQUESTS","message":"Too many requests received within interval","retryAfterSec":30}`},
	)
	p := keyProvider(t, s)
	ctx := context.Background()
	for range 2 {
		_, err := p.GetRecords(ctx, "example.com.")
		dnstest.NoSecret(t, err, apiKey, apiSecret)
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
	if _, err := p.SetRecords(ctx, "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.1", 600)}); dnsx.Code(err) != "dns_rate_limited" {
		t.Fatalf("429: %v", err)
	}
	if _, err := p.AppendRecords(ctx, "example.com.", []libdns.Record{dnstest.CNAME("@", "edge.example.net", 600)}); !errors.Is(err, dnsx.ErrUnsupported) {
		t.Fatalf("apex CNAME: %v", err)
	}
	for _, bad := range []string{"", "key:", ":secret", "short:secret12", apiKey + ":" + apiSecret + ":x", "sso-key " + apiKey, apiKey + ":bad secret"} {
		if _, err := New(map[string]string{"api_token": bad}, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed token accepted: %q", bad)
		}
	}
}
