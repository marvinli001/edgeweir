package hetzner

// Responses follow the examples of the Hetzner Cloud API reference
// (https://docs.hetzner.cloud/reference/cloud#zones, #zone-rrsets,
// #zone-rrset-actions, #zone-actions, "Errors", "Pagination").

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

const token = "LRK9DAWQ1ZAEFSrCNEEzLCUwhYX1U3g7wMg4dTlkkDC96fyDuyJ39nVbVjCKSDfj"

var auth = map[string]string{"Authorization": "Bearer " + token, "User-Agent": "edgeweir-certd/1"}

func provider(t *testing.T, s *dnstest.Server) (*Provider, *[]time.Duration) {
	t.Helper()
	p, err := New(map[string]string{"api_token": token}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	var slept []time.Duration
	p.(*Provider).sleep = func(_ context.Context, d time.Duration) error {
		slept = append(slept, d)
		return nil
	}
	return p.(*Provider), &slept
}

func rrsetJSON(name, typ, ttl string, values ...string) string {
	records := make([]string, 0, len(values))
	for _, v := range values {
		records = append(records, `{"value":`+v+`,"comment":""}`)
	}
	return `{"id":"` + name + `/` + typ + `","name":"` + name + `","type":"` + typ + `","ttl":` + ttl +
		`,"labels":{},"protection":{"change":false},"records":[` + strings.Join(records, ",") + `],"zone":42}`
}

func listCall(page, next string, rrsets ...string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "GET", Path: "/v1/zones/example.com/rrsets",
		Query:  map[string]string{"page": page, "per_page": "100"},
		Header: auth,
		Response: `{"rrsets":[` + strings.Join(rrsets, ",") + `],"meta":{"pagination":{"page":` + page +
			`,"per_page":100,"previous_page":null,"next_page":` + next + `,"last_page":2,"total_entries":null}}}`,
	}
}

func actionJSON(id, command, status string) string {
	return `{"action":{"id":` + id + `,"command":"` + command + `","status":"` + status + `","progress":50,"started":"2016-01-30T23:55:00Z","finished":null,"resources":[{"id":42,"type":"zone"}],"error":null}}`
}

var (
	wwwA   = rrsetJSON("www", "A", "3600", `"198.51.100.1"`, `"198.51.100.2"`)
	apexTX = rrsetJSON("@", "TXT", "300", `"\"keep\""`)
	mailAA = rrsetJSON("mail", "AAAA", "3600", `"2001:db8::1"`)
)

func TestGetRecordsPaginates(t *testing.T) {
	s := dnstest.Serve(t,
		listCall("1", "2", wwwA, rrsetJSON("@", "TXT", "null", `"\"ke\" \"ep\""`)),
		listCall("2", "null", rrsetJSON("cdn", "CNAME", "300", `"edge.example.net."`)),
		// The TXT RRset has no TTL of its own: the zone default applies.
		dnstest.Exchange{Method: "GET", Path: "/v1/zones/example.com", Header: auth,
			Response: `{"zone":{"id":42,"name":"example.com","created":"2016-01-30T23:55:00Z","mode":"primary","primary_nameservers":[],"labels":{},"protection":{"delete":false},"ttl":10800,"status":"ok","record_count":4,"registrar":"other"}}`},
	)
	p, _ := provider(t, s)
	records, err := p.GetRecords(context.Background(), "Example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 4 || !dnstest.Has(records, "www", "A", "198.51.100.2") || !dnstest.Has(records, "cdn", "CNAME", "edge.example.net") {
		t.Fatalf("records: %+v", records)
	}
	txt := records[2].RR()
	if txt.Name != "@" || txt.Data != "keep" || txt.TTL != 10800*time.Second || records[0].RR().TTL != time.Hour {
		t.Fatalf("txt %+v www %+v", txt, records[0].RR())
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		listCall("1", "null", wwwA),
		// 198.51.100.1 exists; 198.51.100.3 is added and keeps the RRset's TTL (no ttl sent).
		dnstest.Exchange{
			Method: "POST", Path: "/v1/zones/example.com/rrsets/www/A/actions/add_records", Header: auth,
			Body:   `{"records":[{"value":"198.51.100.3"}]}`,
			Status: 201, Response: actionJSON("1", "add_rrset_records", "running"),
		},
		dnstest.Exchange{Method: "GET", Path: "/v1/zones/actions/1", Header: auth, Response: actionJSON("1", "add_rrset_records", "running")},
		dnstest.Exchange{Method: "GET", Path: "/v1/zones/actions/1", Response: actionJSON("1", "add_rrset_records", "success")},
		// A new RRset is created by add_records with the input TTL (raised to 60 s) and a quoted TXT value.
		dnstest.Exchange{
			Method: "POST", Path: "/v1/zones/example.com/rrsets/_acme-challenge/TXT/actions/add_records",
			Body:   `{"records":[{"value":"\"token-value\""}],"ttl":60}`,
			Status: 201, Response: actionJSON("2", "add_rrset_records", "success"),
		},
	)
	p, slept := provider(t, s)
	done, err := p.AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "198.51.100.1", 60), dnstest.A("www", "198.51.100.3", 60),
		dnstest.TXT("_acme-challenge.example.com.", "token-value", 30),
	})
	if err != nil || len(done) != 2 || done[0].RR().TTL != time.Hour || done[1].RR().TTL != time.Minute {
		t.Fatalf("done %v err %v", done, err)
	}
	if len(*slept) != 2 || (*slept)[0] != 500*time.Millisecond || (*slept)[1] != time.Second {
		t.Fatalf("polls: %v", *slept)
	}
}

func TestSetRecordsReplacesTheRRset(t *testing.T) {
	s := dnstest.Serve(t,
		listCall("1", "null", wwwA, apexTX, mailAA),
		// www/A: 198.51.100.1 stays, .2 goes, .3 comes, then the TTL changes.
		dnstest.Exchange{
			Method: "POST", Path: "/v1/zones/example.com/rrsets/www/A/actions/set_records", Header: auth,
			JSON:   map[string]any{"records": []any{map[string]any{"value": "198.51.100.1"}, map[string]any{"value": "198.51.100.3"}}},
			Status: 201, Response: actionJSON("3", "set_rrset_records", "success"),
		},
		dnstest.Exchange{
			Method: "POST", Path: "/v1/zones/example.com/rrsets/www/A/actions/change_ttl", Header: auth,
			Body: `{"ttl":60}`, Status: 201, Response: actionJSON("4", "change_rrset_ttl", "success"),
		},
		// cdn/CNAME does not exist yet.
		dnstest.Exchange{
			Method: "POST", Path: "/v1/zones/example.com/rrsets", Header: auth,
			JSON:   map[string]any{"name": "cdn", "type": "CNAME", "ttl": 300, "records": []any{map[string]any{"value": "edge.example.net."}}},
			Status: 201, Response: `{"rrset":` + rrsetJSON("cdn", "CNAME", "300", `"edge.example.net."`) + `,` + strings.TrimPrefix(actionJSON("5", "create_rrset", "success"), "{"),
		},
		// @/TXT already holds exactly "keep" with TTL 300: no request; mail/AAAA is not in the input.
	)
	p, _ := provider(t, s)
	set, err := p.SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "198.51.100.1", 60), dnstest.A("www", "198.51.100.3", 60),
		dnstest.CNAME("cdn", "edge.example.net", 300), dnstest.TXT("@", "keep", 300),
	})
	if err != nil || len(set) != 4 {
		t.Fatalf("set %v err %v", set, err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		listCall("1", "null", wwwA, apexTX, mailAA),
		dnstest.Exchange{
			Method: "POST", Path: "/v1/zones/example.com/rrsets/www/A/actions/remove_records", Header: auth,
			Body:   `{"records":[{"value":"198.51.100.2"}]}`,
			Status: 201, Response: actionJSON("6", "remove_rrset_records", "success"),
		},
		// Every member goes: the RRset is deleted.
		dnstest.Exchange{Method: "DELETE", Path: "/v1/zones/example.com/rrsets/@/TXT", Header: auth, Status: 201, Response: actionJSON("7", "delete_rrset", "running")},
		dnstest.Exchange{Method: "GET", Path: "/v1/zones/actions/7", Response: actionJSON("7", "delete_rrset", "success")},
	)
	p, _ := provider(t, s)
	deleted, err := p.DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "198.51.100.2", 0), libdns.RR{Name: "@", Type: "TXT"}, dnstest.A("www", "203.0.113.9", 0),
	})
	if err != nil || len(deleted) != 2 || !dnstest.Has(deleted, "@", "TXT", "keep") || !dnstest.Has(deleted, "www", "A", "198.51.100.2") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	zone := func(name string) string {
		return `{"id":42,"name":"` + name + `","created":"2016-01-30T23:55:00Z","mode":"primary","primary_nameservers":[],"labels":{},"protection":{"delete":false},"ttl":10800,"status":"ok","record_count":0,"registrar":"other"}`
	}
	s := dnstest.Serve(t,
		dnstest.Exchange{
			Method: "GET", Path: "/v1/zones", Header: auth, Query: map[string]string{"mode": "primary", "page": "1", "per_page": "50"},
			Response: `{"zones":[` + zone("example.com") + `],"meta":{"pagination":{"page":1,"per_page":50,"previous_page":null,"next_page":2,"last_page":2,"total_entries":2}}}`,
		},
		dnstest.Exchange{
			Method: "GET", Path: "/v1/zones", Query: map[string]string{"mode": "primary", "page": "2", "per_page": "50"},
			Response: `{"zones":[` + zone("example.net") + `],"meta":{"pagination":{"page":2,"per_page":50,"previous_page":1,"next_page":null,"last_page":2,"total_entries":2}}}`,
		},
	)
	p, _ := provider(t, s)
	zones, err := p.ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestLockedZoneIsRetried(t *testing.T) {
	s := dnstest.Serve(t,
		listCall("1", "null"),
		dnstest.Exchange{Method: "POST", Path: "/v1/zones/example.com/rrsets/www/A/actions/add_records", Status: 423,
			Response: `{"error":{"code":"locked","message":"there is already an action running","details":null}}`},
		dnstest.Exchange{Method: "POST", Path: "/v1/zones/example.com/rrsets/www/A/actions/add_records", Status: 201, Response: actionJSON("8", "add_rrset_records", "success")},
	)
	p, slept := provider(t, s)
	if _, err := p.AppendRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("www", "198.51.100.1", 60)}); err != nil {
		t.Fatal(err)
	}
	if len(*slept) != 1 || (*slept)[0] != time.Second {
		t.Fatalf("retry delays: %v", *slept)
	}
}

func TestErrors(t *testing.T) {
	failed := `{"action":{"id":9,"command":"set_rrset_records","status":"error","progress":100,"started":"2016-01-30T23:55:00Z","finished":"2016-01-30T23:56:00Z","resources":[{"id":42,"type":"zone"}],"error":{"code":"action_failed","message":"Action failed"}}}`
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/v1/zones/example.com/rrsets", Status: 401, Response: `{"error":{"code":"unauthorized","message":"unable to authenticate","details":null}}`},
		dnstest.Exchange{Method: "GET", Path: "/v1/zones/example.com/rrsets", Status: 404, Response: `{"error":{"code":"not_found","message":"zone with name example.com not found","details":null}}`},
		dnstest.Exchange{Method: "GET", Path: "/v1/zones/example.com/rrsets", Status: 422, Response: `{"error":{"code":"incorrect_zone_mode","message":"This operation is not supported for this Zone's mode.","details":null}}`},
		dnstest.Exchange{Method: "GET", Path: "/v1/zones/example.com/rrsets", Status: 429, Response: `{"error":{"code":"rate_limit_exceeded","message":"limit of 3600 requests per hour reached","details":null}}`},
		dnstest.Exchange{Method: "GET", Path: "/v1/zones/example.com/rrsets", Status: 503, Response: `{"error":{"code":"unavailable","message":"service unavailable","details":null}}`},
		// A read-only token.
		listCall("1", "null"),
		dnstest.Exchange{Method: "POST", Path: "/v1/zones/example.com/rrsets", Status: 401, Response: `{"error":{"code":"token_readonly","message":"The token is only allowed to perform GET requests.","details":null}}`},
		// A failed action.
		listCall("1", "null", wwwA),
		dnstest.Exchange{Method: "POST", Path: "/v1/zones/example.com/rrsets/www/A/actions/set_records", Status: 201, Response: failed},
	)
	p, _ := provider(t, s)
	ctx := context.Background()
	_, err := p.GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, token)
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("401: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_unsupported" {
		t.Fatalf("secondary zone: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_rate_limited" {
		t.Fatalf("429: %v", err)
	}
	_, err = p.GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, token)
	if dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	_, err = p.SetRecords(ctx, "example.com.", []libdns.Record{dnstest.A("new", "198.51.100.1", 60)})
	dnstest.NoSecret(t, err, token)
	if dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("read-only token: %v", err)
	}
	_, err = p.SetRecords(ctx, "example.com.", []libdns.Record{dnstest.A("www", "198.51.100.9", 3600)})
	if dnsx.Code(err) != "dns_provider_error" || !strings.Contains(err.Error(), "action_failed") {
		t.Fatalf("failed action: %v", err)
	}
	for _, bad := range []string{"", "short", "LRK9DAWQ1ZAEFSrCNEEzLCUwhYX1U3g7 wMg4dTlkkDC96fyDuyJ39nVbVjCKSDfj", token + "\n"} {
		if _, err := New(map[string]string{"api_token": bad}, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed token %q accepted: %v", bad, err)
		}
	}
}

func TestQuote(t *testing.T) {
	long := strings.Repeat("a", 300)
	for in, want := range map[string]string{
		"token-value":   `"token-value"`,
		`say "hi" \o/`:  `"say \"hi\" \\o/"`,
		"":              `""`,
		long:            `"` + long[:255] + `" "` + long[255:] + `"`,
		"v=spf1 -all ;": `"v=spf1 -all ;"`,
	} {
		if got := quote(in); got != want {
			t.Fatalf("quote(%q) = %q, want %q", in, got, want)
		}
		if back := dnsx.Unquote(quote(in)); back != in {
			t.Fatalf("round trip %q -> %q", in, back)
		}
	}
}
