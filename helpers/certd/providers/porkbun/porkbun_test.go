package porkbun

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Requests and responses follow the Porkbun API v3 OpenAPI spec
// (https://porkbun.com/api/json/v3/spec, documented at
// https://porkbun.com/api/json/v3/documentation): /dns/retrieve, /dns/create,
// /dns/edit, /dns/delete, /domain/listAll and the ErrorResponse codes.
const (
	apiKey    = "pk1_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	secretKey = "sk1_fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
)

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	p, err := New(map[string]string{"api_key": apiKey, "api_secret_key": secretKey}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return p.(*Provider)
}

var creds = map[string]any{"apikey": apiKey, "secretapikey": secretKey}

func with(fields map[string]any) map[string]any {
	out := map[string]any{"apikey": apiKey, "secretapikey": secretKey}
	for k, v := range fields {
		out[k] = v
	}
	return out
}

func post(path string, json any, response string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "POST", Path: path, JSON: json,
		Header:   map[string]string{"Content-Type": "application/json", "User-Agent": "edgeweir-certd/1"},
		Response: response,
	}
}

func retrieve(records string) dnstest.Exchange {
	return post("/dns/retrieve/example.com", creds, `{"status":"SUCCESS","cloudflare":"disabled","records":[`+records+`]}`)
}

const ok = `{"status":"SUCCESS"}`

const existing = `{"id":"106926652","name":"www.example.com","type":"A","content":"192.0.2.1","ttl":"600","prio":"0","notes":""},
{"id":"106926653","name":"www.example.com","type":"A","content":"192.0.2.2","ttl":"600","prio":null,"notes":null},
{"id":106926654,"name":"example.com","type":"TXT","content":"keep","ttl":"600","prio":null,"notes":null},
{"id":"106926655","name":"example.com","type":"MX","content":"mail.example.com","ttl":"600","prio":"10","notes":null},
{"id":"106926656","name":"_acme-challenge.example.com","type":"TXT","content":"token","ttl":"600","prio":null,"notes":null}`

func TestGetRecords(t *testing.T) {
	s := dnstest.Serve(t, retrieve(existing))
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 5 || !dnstest.Has(records, "www", "A", "192.0.2.2") || !dnstest.Has(records, "@", "TXT", "keep") || !dnstest.Has(records, "@", "MX", "10 mail.example.com") {
		t.Fatalf("records: %+v", records)
	}
	if records[0].RR().TTL.Seconds() != 600 {
		t.Fatalf("ttl: %v", records[0].RR().TTL)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		post("/dns/create/example.com", with(map[string]any{"name": "_acme-challenge", "type": "TXT", "content": "token", "ttl": 600}),
			`{"status":"SUCCESS","id":"106926659"}`),
		post("/dns/create/example.com", with(map[string]any{"name": "", "type": "ALIAS", "content": "edge.example.net", "ttl": 3600}),
			`{"status":"SUCCESS","id":"106926660","warnings":[]}`),
		// Already present: Porkbun answers DUPLICATE_RECORD with the existing ID.
		dnstest.Exchange{Method: "POST", Path: "/dns/create/example.com", Status: 400,
			Response: `{"status":"ERROR","message":"A record with this exact name, type and content already exists.","code":"DUPLICATE_RECORD","existingId":"106926652"}`},
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", "token", 60),
		libdns.RR{Name: "@", Type: "ALIAS", Data: "edge.example.net.", TTL: time.Hour},
		dnstest.A("www", "192.0.2.1", 600),
	})
	if err != nil || len(done) != 3 || done[0].RR().TTL.Seconds() != 600 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsReplacesTheRRset(t *testing.T) {
	s := dnstest.Serve(t,
		retrieve(existing),
		// 192.0.2.1 stays with a new TTL, 192.0.2.2 goes, 192.0.2.3 is created;
		// the TXT and MX RRsets are untouched.
		post("/dns/edit/example.com/106926652", with(map[string]any{"name": "www", "type": "A", "content": "192.0.2.1", "ttl": 1200}), ok),
		post("/dns/delete/example.com/106926653", creds, ok),
		post("/dns/create/example.com", with(map[string]any{"name": "www", "type": "A", "content": "192.0.2.3", "ttl": 1200}), `{"status":"SUCCESS","id":"106926661"}`),
	)
	_, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 1200), dnstest.A("WWW", "192.0.2.3", 1200),
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSetRecordsBelowTheMinimumTTLIsUnchanged(t *testing.T) {
	s := dnstest.Serve(t, retrieve(existing))
	if _, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{dnstest.TXT("@", "keep", 60)}); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		retrieve(existing),
		post("/dns/delete/example.com/106926653", creds, ok),
		post("/dns/delete/example.com/106926656", creds, ok),
	)
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 60),
		libdns.RR{Name: "_acme-challenge", Type: "TXT"}, // whole RRset
		dnstest.A("www", "192.0.2.9", 60),               // absent: ignored
	})
	if err != nil || len(deleted) != 2 || !dnstest.Has(deleted, "www", "A", "192.0.2.2") || !dnstest.Has(deleted, "_acme-challenge", "TXT", "token") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZonesFollowsPages(t *testing.T) {
	first := make([]string, 1000)
	for i := range first {
		first[i] = fmt.Sprintf(`{"domain":"example%04d.com","status":"ACTIVE","tld":"com","apiAccess":1,"notLocal":0}`, i)
	}
	s := dnstest.Serve(t,
		post("/domain/listAll", with(map[string]any{"start": 0}), `{"status":"SUCCESS","count":1000,"domains":[`+strings.Join(first, ",")+`]}`),
		post("/domain/listAll", with(map[string]any{"start": 1000}), `{"status":"SUCCESS","count":1,"domains":[{"domain":"Example.NET","status":"ACTIVE","tld":"net","apiAccess":0,"notLocal":0}]}`),
	)
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 1001 || zones[0].Name != "example0000.com." || zones[1000].Name != "example.net." {
		t.Fatalf("zones %d err %v", len(zones), err)
	}
}

func TestErrors(t *testing.T) {
	fail := func(status int, response string) dnstest.Exchange {
		return dnstest.Exchange{Method: "POST", Path: "/dns/retrieve/example.com", Status: status, Response: response}
	}
	s := dnstest.Serve(t,
		fail(400, `{"status":"ERROR","message":"Invalid API key. (001)","code":"INVALID_API_KEYS_001","next_action":{"type":"authenticate","hint":"Check the key pair.","url":"https://porkbun.com/account/api"}}`),
		fail(400, `{"status":"ERROR","message":"Domain is not opted in to API access.","next_action":{"type":"enable_setting","hint":"Enable API access for this domain.","url":"https://porkbun.com/account/domainsSpeedy"}}`),
		fail(403, `{"status":"ERROR","message":"This API key is not allowed to operate on this domain.","code":"DOMAIN_NOT_ALLOWED"}`),
		fail(400, `{"status":"ERROR","message":"Invalid domain.","code":"INVALID_DOMAIN","next_action":{"type":"fix_request","hint":"Check the domain."}}`),
		fail(503, `<html>unavailable</html>`),
		fail(429, `{"status":"ERROR","message":"Rate limit exceeded.","code":"RATE_LIMIT_EXCEEDED","ttlRemaining":12}`),
	)
	p := provider(t, s)
	ctx := context.Background()
	for i := range 3 {
		_, err := p.GetRecords(ctx, "example.com.")
		dnstest.NoSecret(t, err, apiKey, secretKey)
		if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
			t.Fatalf("auth failure %d: %v", i, err)
		}
	}
	if _, err := p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err := p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	if _, err := p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_rate_limited" {
		t.Fatalf("429: %v", err)
	}
	for _, f := range []map[string]string{
		{"api_key": "", "api_secret_key": secretKey},
		{"api_key": apiKey, "api_secret_key": apiKey},
		{"api_key": "pk1_short", "api_secret_key": secretKey},
		{"api_key": apiKey + "\"", "api_secret_key": secretKey},
	} {
		if _, err := New(f, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed keys accepted: %q", f)
		}
	}
}
