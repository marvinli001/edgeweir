package vultr

// Responses follow the examples of the Vultr API v2 reference
// (https://www.vultr.com/api/#tag/dns): list-dns-domain-records,
// create-dns-domain-record, update-dns-domain-record,
// delete-dns-domain-record, list-dns-domains, "Meta and Pagination" and the
// error body {"error","status"}.

import (
	"context"
	"errors"
	"testing"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const key = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

var auth = map[string]string{"Authorization": "Bearer " + key, "User-Agent": "edgeweir-certd/1"}

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	p, err := New(map[string]string{"api_key": key}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return p.(*Provider)
}

func listCall(cursor, records, next string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "GET", Path: "/v2/domains/example.com/records",
		Query:    map[string]string{"per_page": "500", "cursor": cursor},
		Header:   auth,
		Response: `{"records":[` + records + `],"meta":{"total":5,"links":{"next":"` + next + `","prev":""}}}`,
	}
}

const existing = `{"id":"cb676a46-66fd-4dfb-b839-443f2e6c0b60","type":"A","name":"www","data":"192.0.2.1","priority":-1,"ttl":600},
{"id":"cb676a46-66fd-4dfb-b839-443f2e6c0b61","type":"A","name":"www","data":"192.0.2.2","priority":-1,"ttl":600},
{"id":"cb676a46-66fd-4dfb-b839-443f2e6c0b62","type":"TXT","name":"","data":"\"keep\"","priority":-1,"ttl":300},
{"id":"cb676a46-66fd-4dfb-b839-443f2e6c0b63","type":"AAAA","name":"www","data":"2001:db8::1","priority":-1,"ttl":600}`

func TestGetRecordsPaginates(t *testing.T) {
	s := dnstest.Serve(t,
		listCall("", existing, "bmV4dF9fY2I2NzZhNDY="),
		listCall("bmV4dF9fY2I2NzZhNDY=", `{"id":"cb676a46-66fd-4dfb-b839-443f2e6c0b64","type":"CNAME","name":"cdn.example.com","data":"edge.example.net","priority":-1,"ttl":300}`, ""),
	)
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 5 || !dnstest.Has(records, "www", "A", "192.0.2.1") || !dnstest.Has(records, "@", "TXT", "keep") ||
		!dnstest.Has(records, "cdn", "CNAME", "edge.example.net") {
		t.Fatalf("records: %+v", records)
	}
	if records[2].RR().Data != "keep" || records[0].RR().TTL.Seconds() != 600 {
		t.Fatalf("txt %q ttl %v", records[2].RR().Data, records[0].RR().TTL)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{
			Method: "POST", Path: "/v2/domains/example.com/records", Header: auth,
			JSON:   map[string]any{"name": "", "type": "TXT", "data": "token-value", "ttl": 120},
			Status: 201, Response: `{"record":{"id":"cb676a46-66fd-4dfb-b839-443f2e6c0b70","type":"TXT","name":"","data":"\"token-value\"","priority":0,"ttl":120}}`,
		},
		dnstest.Exchange{
			Method: "POST", Path: "/v2/domains/example.com/records", Header: auth,
			JSON:   map[string]any{"name": "cdn", "type": "CNAME", "data": "edge.example.net", "ttl": 300},
			Status: 201, Response: `{"record":{"id":"cb676a46-66fd-4dfb-b839-443f2e6c0b71","type":"CNAME","name":"cdn","data":"edge.example.net","priority":0,"ttl":300}}`,
		},
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("@", "token-value", 120), dnstest.CNAME("cdn", "edge.example.net.", 300),
	})
	if err != nil || len(done) != 2 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsReplacesTheRRset(t *testing.T) {
	s := dnstest.Serve(t,
		listCall("", existing, ""),
		// 192.0.2.1 stays with a new TTL, 192.0.2.2 goes, 192.0.2.3 is created; TXT and AAAA are untouched.
		dnstest.Exchange{
			Method: "PATCH", Path: "/v2/domains/example.com/records/cb676a46-66fd-4dfb-b839-443f2e6c0b60", Header: auth,
			Body: `{"ttl":60}`, Status: 204,
		},
		dnstest.Exchange{Method: "DELETE", Path: "/v2/domains/example.com/records/cb676a46-66fd-4dfb-b839-443f2e6c0b61", Header: auth, Status: 204},
		dnstest.Exchange{
			Method: "POST", Path: "/v2/domains/example.com/records",
			JSON:   map[string]any{"name": "www", "type": "A", "data": "192.0.2.3", "ttl": 60},
			Status: 201, Response: `{"record":{"id":"cb676a46-66fd-4dfb-b839-443f2e6c0b72","type":"A","name":"www","data":"192.0.2.3","priority":0,"ttl":60}}`,
		},
	)
	set, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60),
	})
	if err != nil || len(set) != 2 {
		t.Fatalf("set %v err %v", set, err)
	}
}

func TestSetRecordsKeepsQuotedTXT(t *testing.T) {
	s := dnstest.Serve(t, listCall("", existing, ""))
	if _, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{dnstest.TXT("@", "keep", 300)}); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		listCall("", existing, ""),
		dnstest.Exchange{Method: "DELETE", Path: "/v2/domains/example.com/records/cb676a46-66fd-4dfb-b839-443f2e6c0b61", Header: auth, Status: 204},
		dnstest.Exchange{Method: "DELETE", Path: "/v2/domains/example.com/records/cb676a46-66fd-4dfb-b839-443f2e6c0b62", Header: auth, Status: 204},
	)
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 0), dnstest.TXT("@", "keep", 0),
	})
	if err != nil || len(deleted) != 2 || !dnstest.Has(deleted, "@", "TXT", "keep") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{
			Method: "GET", Path: "/v2/domains", Query: map[string]string{"per_page": "500", "cursor": ""}, Header: auth,
			Response: `{"domains":[{"domain":"example.com","date_created":"2020-10-10T01:56:20+00:00","dns_sec":"enabled"}],"meta":{"total":2,"links":{"next":"bmV4dF9fZXhhbXBsZS5uZXQ=","prev":""}}}`,
		},
		dnstest.Exchange{
			Method: "GET", Path: "/v2/domains", Query: map[string]string{"per_page": "500", "cursor": "bmV4dF9fZXhhbXBsZS5uZXQ="},
			Response: `{"domains":[{"domain":"Example.NET","date_created":"2020-10-10T01:56:20+00:00","dns_sec":"disabled"}],"meta":{"total":2,"links":{"next":"","prev":"cHJldl9fZXhhbXBsZS5uZXQ="}}}`,
		},
	)
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/v2/domains/example.com/records", Status: 401, Response: `{"error":"Invalid API token.","status":401}`},
		// API access control refuses the console's address.
		dnstest.Exchange{Method: "GET", Path: "/v2/domains/example.com/records", Status: 401, Response: `{"error":"Unauthorized IP address: 203.0.113.9","status":401}`},
		dnstest.Exchange{Method: "GET", Path: "/v2/domains/example.com/records", Status: 404, Response: `{"error":"Domain not found","status":404}`},
		dnstest.Exchange{Method: "GET", Path: "/v2/domains/example.com/records", Status: 429, Response: `{"error":"Rate limit reached","status":429}`},
		dnstest.Exchange{Method: "GET", Path: "/v2/domains/example.com/records", Status: 503, Response: `<html>unavailable</html>`},
		dnstest.Exchange{Method: "GET", Path: "/v2/domains/example.com/records", Response: `{"records":[],"meta":{"total":1,"links":{"next":"c2FtZQ==","prev":""}}}`},
	)
	p := provider(t, s)
	ctx := context.Background()
	_, err := p.GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, key)
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("401: %v", err)
	}
	_, err = p.GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, key)
	if dnsx.Code(err) != "dns_auth_failed" || err.Error() != "HTTP 401: Unauthorized IP address: 203.0.113.9" {
		t.Fatalf("access control: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_rate_limited" {
		t.Fatalf("429: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	// An empty page ends the listing even when a cursor is present.
	if records, err := p.GetRecords(ctx, "example.com."); err != nil || len(records) != 0 {
		t.Fatalf("empty page: %v %v", records, err)
	}
	for _, bad := range []string{"", "short", "ABCDEFGHIJKLMNOPQR STUVWXYZ0123456789", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678\r"} {
		if _, err := New(map[string]string{"api_key": bad}, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed key %q accepted: %v", bad, err)
		}
	}
}

func TestRepeatedCursorStops(t *testing.T) {
	s := dnstest.Serve(t,
		listCall("", existing, "c2FtZQ=="),
		listCall("c2FtZQ==", existing, "c2FtZQ=="),
	)
	if _, err := provider(t, s).GetRecords(context.Background(), "example.com."); !errors.Is(err, dnsx.ErrProvider) {
		t.Fatalf("repeated cursor: %v", err)
	}
}
