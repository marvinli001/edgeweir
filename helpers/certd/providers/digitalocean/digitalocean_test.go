package digitalocean

// Responses follow the examples of the DigitalOcean API reference
// (https://docs.digitalocean.com/reference/api/digitalocean/#tag/Domain-Records,
// https://docs.digitalocean.com/reference/api/digitalocean/#tag/Domains):
// domains_list_records, domains_create_record, domains_update_record,
// domains_delete_record, domains_list and the error object {"id","message"}.

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

func listCall(page, records, links string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "GET", Path: "/v2/domains/example.com/records",
		Query:    map[string]string{"page": page, "per_page": "200"},
		Header:   auth,
		Response: `{"domain_records":[` + records + `],"links":` + links + `,"meta":{"total":6}}`,
	}
}

const existing = `{"id":28448429,"type":"NS","name":"@","data":"ns1.digitalocean.com","priority":null,"port":null,"ttl":1800,"weight":null,"flags":null,"tag":null},
{"id":10,"type":"A","name":"www","data":"192.0.2.1","priority":null,"port":null,"ttl":600,"weight":null,"flags":null,"tag":null},
{"id":11,"type":"A","name":"www","data":"192.0.2.2","priority":null,"port":null,"ttl":600,"weight":null,"flags":null,"tag":null},
{"id":12,"type":"TXT","name":"@","data":"keep","priority":null,"port":null,"ttl":1800,"weight":null,"flags":null,"tag":null},
{"id":13,"type":"AAAA","name":"www","data":"2001:db8::1","priority":null,"port":null,"ttl":600,"weight":null,"flags":null,"tag":null}`

const lastPage = `{}`

func TestGetRecordsPaginates(t *testing.T) {
	s := dnstest.Serve(t,
		listCall("1", existing, `{"pages":{"last":"https://api.digitalocean.com/v2/domains/example.com/records?page=2&per_page=200","next":"https://api.digitalocean.com/v2/domains/example.com/records?page=2&per_page=200"}}`),
		listCall("2", `{"id":14,"type":"CNAME","name":"cdn","data":"edge.example.net.","priority":null,"port":null,"ttl":300,"weight":null,"flags":null,"tag":null}`,
			`{"pages":{"first":"https://api.digitalocean.com/v2/domains/example.com/records?page=1&per_page=200","prev":"https://api.digitalocean.com/v2/domains/example.com/records?page=1&per_page=200"}}`),
	)
	records, err := provider(t, s).GetRecords(context.Background(), "Example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 6 || !dnstest.Has(records, "www", "A", "192.0.2.1") || !dnstest.Has(records, "@", "TXT", "keep") ||
		!dnstest.Has(records, "cdn", "CNAME", "edge.example.net") || !dnstest.Has(records, "@", "NS", "ns1.digitalocean.com") {
		t.Fatalf("records: %+v", records)
	}
	if records[1].RR().TTL.Seconds() != 600 {
		t.Fatalf("ttl: %v", records[1].RR().TTL)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{
			Method: "POST", Path: "/v2/domains/example.com/records", Header: auth,
			JSON:   map[string]any{"type": "CNAME", "name": "cdn", "data": "edge.example.net.", "ttl": 60},
			Status: 201, Response: `{"domain_record":{"id":28448433,"type":"CNAME","name":"cdn","data":"edge.example.net.","priority":null,"port":null,"ttl":60,"weight":null,"flags":null,"tag":null}}`,
		},
		dnstest.Exchange{
			Method: "POST", Path: "/v2/domains/example.com/records",
			// 10 s is raised to the 30 s minimum.
			JSON:   map[string]any{"type": "TXT", "name": "_acme-challenge", "data": "token-value", "ttl": 30},
			Status: 201, Response: `{"domain_record":{"id":28448434,"type":"TXT","name":"_acme-challenge","data":"token-value","priority":null,"port":null,"ttl":30,"weight":null,"flags":null,"tag":null}}`,
		},
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.CNAME("cdn", "edge.example.net", 60), dnstest.TXT("_acme-challenge.example.com.", "token-value", 10),
	})
	if err != nil || len(done) != 2 || done[1].RR().Name != "_acme-challenge" || done[1].RR().TTL.Seconds() != 30 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsReplacesTheRRset(t *testing.T) {
	s := dnstest.Serve(t,
		listCall("1", existing, lastPage),
		// 192.0.2.1 stays with a new TTL, 192.0.2.2 goes, 192.0.2.3 is created; TXT, NS and AAAA are untouched.
		dnstest.Exchange{
			Method: "PUT", Path: "/v2/domains/example.com/records/10", Header: auth,
			JSON:     map[string]any{"type": "A", "name": "www", "data": "192.0.2.1", "ttl": 60},
			Response: `{"domain_record":{"id":10,"type":"A","name":"www","data":"192.0.2.1","priority":null,"port":null,"ttl":60,"weight":null,"flags":null,"tag":null}}`,
		},
		dnstest.Exchange{Method: "DELETE", Path: "/v2/domains/example.com/records/11", Header: auth, Status: 204},
		dnstest.Exchange{
			Method: "POST", Path: "/v2/domains/example.com/records",
			JSON:   map[string]any{"type": "A", "name": "www", "data": "192.0.2.3", "ttl": 60},
			Status: 201, Response: `{"domain_record":{"id":15,"type":"A","name":"www","data":"192.0.2.3","priority":null,"port":null,"ttl":60,"weight":null,"flags":null,"tag":null}}`,
		},
	)
	set, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60),
	})
	if err != nil || len(set) != 2 {
		t.Fatalf("set %v err %v", set, err)
	}
}

func TestSetRecordsKeepsUnchangedMembers(t *testing.T) {
	s := dnstest.Serve(t, listCall("1", existing, lastPage))
	if _, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{dnstest.TXT("@", "keep", 1800)}); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		listCall("1", existing, lastPage),
		dnstest.Exchange{Method: "DELETE", Path: "/v2/domains/example.com/records/11", Header: auth, Status: 204},
		dnstest.Exchange{Method: "DELETE", Path: "/v2/domains/example.com/records/13", Header: auth, Status: 204},
	)
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 0), libdns.RR{Name: "www", Type: "AAAA"},
	})
	if err != nil || len(deleted) != 2 || !dnstest.Has(deleted, "www", "AAAA", "2001:db8::1") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{
			Method: "GET", Path: "/v2/domains", Query: map[string]string{"page": "1", "per_page": "200"}, Header: auth,
			Response: `{"domains":[{"name":"example.com","ttl":1800,"zone_file":"$ORIGIN example.com.\n"}],"links":{"pages":{"last":"https://api.digitalocean.com/v2/domains?page=2&per_page=200","next":"https://api.digitalocean.com/v2/domains?page=2&per_page=200"}},"meta":{"total":2}}`,
		},
		dnstest.Exchange{
			Method: "GET", Path: "/v2/domains", Query: map[string]string{"page": "2", "per_page": "200"},
			Response: `{"domains":[{"name":"Example.NET","ttl":1800,"zone_file":""}],"links":{"pages":{"first":"https://api.digitalocean.com/v2/domains?page=1&per_page=200","prev":"https://api.digitalocean.com/v2/domains?page=1&per_page=200"}},"meta":{"total":2}}`,
		},
	)
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/v2/domains/example.com/records", Status: 401, Response: `{"id":"unauthorized","message":"Unable to authenticate you."}`},
		dnstest.Exchange{Method: "GET", Path: "/v2/domains/example.com/records", Status: 403, Response: `{"id":"Forbidden","message":"You are not authorized to perform this operation"}`},
		dnstest.Exchange{Method: "GET", Path: "/v2/domains/example.com/records", Status: 404, Response: `{"id":"not_found","message":"The resource you requested could not be found."}`},
		dnstest.Exchange{Method: "GET", Path: "/v2/domains/example.com/records", Status: 429, Response: `{"id":"too_many_requests","message":"API rate limit exceeded."}`},
		dnstest.Exchange{Method: "GET", Path: "/v2/domains/example.com/records", Status: 500, Response: `{"id":"server_error","message":"Unexpected server-side error"}`},
		dnstest.Exchange{Method: "POST", Path: "/v2/domains/example.com/records", Status: 422, Response: `{"id":"unprocessable_entity","message":"Data needs to end with a dot (.)"}`},
	)
	p := provider(t, s)
	ctx := context.Background()
	_, err := p.GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, token, "0123456789abcdef")
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("401: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("403 (missing scope): %v", err)
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
	_, err = p.AppendRecords(ctx, "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.9", 60)})
	dnstest.NoSecret(t, err, token)
	if dnsx.Code(err) != "dns_provider_error" {
		t.Fatalf("422: %v", err)
	}
	for _, bad := range []string{"", "short", "dop_v1_ with space 0123456789abcdef", "dop_v1_0123456789abcdef\n"} {
		if _, err := New(map[string]string{"api_token": bad}, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed token %q accepted: %v", bad, err)
		}
	}
	if _, err := p.GetRecords(ctx, "bad/zone."); !errors.Is(err, dnsx.ErrInvalid) {
		t.Fatalf("malformed zone: %v", err)
	}
}
