package webhook

// The protocol is edgeweir's own; it is specified in the package
// documentation (webhook.go). The receiver side below checks every request
// with the documented signature formula.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/netip"
	"testing"
	"time"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	secret    = "example-secret-0123456789"
	timestamp = "1700000000"
)

var loopback = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	// No HTTPClient: the real policy client dials the test server on 127.0.0.1.
	p, err := New(map[string]string{"url": s.URL + "/hook?tenant=a", "secret": secret}, dnsx.Options{AllowCIDRs: loopback})
	if err != nil {
		t.Fatal(err)
	}
	pr := p.(*Provider)
	pr.now = func() time.Time { return time.Unix(1700000000, 0) }
	return pr
}

// verify is the receiver's check: HMAC-SHA256(secret, timestamp + "." + raw body).
func verify(t *testing.T, r *http.Request, body []byte) {
	t.Helper()
	ts := r.Header.Get("X-Edgeweir-Timestamp")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "." + string(body)))
	if got, want := r.Header.Get("X-Edgeweir-Signature"), "v1="+hex.EncodeToString(mac.Sum(nil)); !hmac.Equal([]byte(got), []byte(want)) {
		t.Errorf("signature %q, want %q", got, want)
	}
}

func call(json any, response string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "POST", Path: "/hook", Query: map[string]string{"tenant": "a"},
		Header: map[string]string{
			"Content-Type": "application/json", "User-Agent": "edgeweir-certd/1", "X-Edgeweir-Timestamp": timestamp,
		},
		JSON: json, Check: verify, Response: response,
	}
}

func TestSignatureKnownAnswer(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{
		Method: "POST", Path: "/hook",
		Header: map[string]string{
			"X-Edgeweir-Timestamp": timestamp,
			// The example in the package documentation.
			"X-Edgeweir-Signature": "v1=3af007dacbb4d9b54c57bc499f275d13e48a5513e8ecf036d83c1b5a6c0f20f8",
		},
		Body:     `{"action":"zones"}`,
		Response: `{"zones":["example.com","Example.NET.",""]}`,
	})
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestGetRecords(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{
		Method: "POST", Path: "/hook", Check: verify,
		Body: `{"action":"list","zone":"example.com"}`,
		Response: `{"records":[{"name":"@","type":"TXT","data":"keep \"me\"","ttl":600},
{"name":"www","type":"A","data":"192.0.2.1","ttl":600},{"name":"www","type":"A","data":"192.0.2.2","ttl":600},
{"name":"cdn.example.com.","type":"cname","data":"edge.example.net.","ttl":300}]}`,
	})
	records, err := provider(t, s).GetRecords(context.Background(), "Example.com.")
	if err != nil || len(records) != 4 {
		t.Fatalf("records %v err %v", records, err)
	}
	if !dnstest.Has(records, "@", "TXT", `keep "me"`) || !dnstest.Has(records, "www", "A", "192.0.2.2") || !dnstest.Has(records, "cdn", "CNAME", "edge.example.net") {
		t.Fatalf("records: %+v", records)
	}
	if records[3].RR().TTL != 300*time.Second || records[3].RR().Type != "CNAME" {
		t.Fatalf("cname: %+v", records[3].RR())
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t, call(
		map[string]any{"action": "append", "zone": "example.com", "records": []map[string]any{
			{"name": "_acme-challenge", "type": "TXT", "data": "token-1", "ttl": 60},
			{"name": "@", "type": "AAAA", "data": "2001:db8::1", "ttl": 1},
		}},
		`{"records":[{"name":"_acme-challenge","type":"TXT","data":"token-1","ttl":60},{"name":"@","type":"AAAA","data":"2001:db8::1","ttl":1}]}`,
	))
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", "token-1", 60),
		dnstest.AAAA("example.com.", "2001:db8::1", 0), // absolute apex name; TTL at least 1 s
	})
	if err != nil || len(done) != 2 || !dnstest.Has(done, "@", "AAAA", "2001:db8::1") {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecords(t *testing.T) {
	// The receiver makes www A exactly {192.0.2.1, 192.0.2.3} and the CNAME
	// exactly edge2; other RRsets are not part of the request.
	s := dnstest.Serve(t, call(
		map[string]any{"action": "set", "zone": "example.com", "records": []map[string]any{
			{"name": "www", "type": "A", "data": "192.0.2.1", "ttl": 60},
			{"name": "www", "type": "A", "data": "192.0.2.3", "ttl": 60},
			{"name": "cdn", "type": "CNAME", "data": "edge2.example.net", "ttl": 300},
		}},
		`{"records":[{"name":"www","type":"A","data":"192.0.2.1","ttl":60},{"name":"www","type":"A","data":"192.0.2.3","ttl":60},{"name":"cdn","type":"CNAME","data":"edge2.example.net.","ttl":300}]}`,
	))
	set, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60), dnstest.CNAME("cdn", "edge2.example.net", 300),
	})
	if err != nil || len(set) != 3 {
		t.Fatalf("set %v err %v", set, err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t, call(
		map[string]any{"action": "delete", "zone": "example.com", "records": []map[string]any{
			{"name": "_acme-challenge", "type": "TXT", "data": "token-1", "ttl": 0},
			{"name": "cdn", "type": "CNAME", "data": "", "ttl": 0},
		}},
		`{"records":[{"name":"_acme-challenge","type":"TXT","data":"token-1","ttl":60}]}`,
	))
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", "token-1", 0),
		libdns.RR{Name: "cdn", Type: "CNAME"}, // whole RRset (absent at the receiver)
	})
	if err != nil || len(deleted) != 1 || !dnstest.Has(deleted, "_acme-challenge", "TXT", "token-1") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestNothingToChangeSendsNothing(t *testing.T) {
	s := dnstest.Serve(t)
	if _, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("www.example.org.", "192.0.2.1", 60)}); !errors.Is(err, dnsx.ErrInvalid) {
		t.Fatalf("out-of-zone name: %v", err)
	}
}

func TestErrors(t *testing.T) {
	list := dnstest.Exchange{Method: "POST", Path: "/hook", Check: verify}
	with := func(status int, response string) dnstest.Exchange {
		e := list
		e.Status, e.Response = status, response
		return e
	}
	s := dnstest.Serve(t,
		with(401, `{"error":"bad signature"}`),
		with(403, ``),
		with(404, `{"error":"unknown zone"}`),
		with(501, ``), // zones
		with(501, ``), // list
		with(429, ``),
		with(400, `{"error":"unsupported record type SRV"}`),
		with(200, `not json`),
	)
	p := provider(t, s)
	ctx := context.Background()
	_, err := p.GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, secret, "v1=")
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("401: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("403: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("404: %v", err)
	}
	if _, err = p.ListZones(ctx); !errors.Is(err, dnsx.ErrUnsupported) || dnsx.Code(err) != "dns_unsupported" {
		t.Fatalf("501 on zones: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("501 on list: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_rate_limited" {
		t.Fatalf("429: %v", err)
	}
	_, err = p.SetRecords(ctx, "example.com.", []libdns.Record{libdns.RR{Name: "srv", Type: "SRV", Data: "0 0 443 x.example.net.", TTL: time.Minute}})
	if dnsx.Code(err) != "dns_provider_error" || err.Error() != "HTTP 400: unsupported record type SRV" {
		t.Fatalf("400: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrProvider) {
		t.Fatalf("invalid JSON: %v", err)
	}
}

func TestPolicyRefusesLoopback(t *testing.T) {
	s := dnstest.Serve(t) // must not be reached
	p, err := New(map[string]string{"url": s.URL + "/hook", "secret": secret}, dnsx.Options{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.GetRecords(context.Background(), "example.com.")
	dnstest.NoSecret(t, err, secret)
	if !errors.Is(err, dnsx.ErrRefused) || dnsx.Code(err) != "dns_address_refused" {
		t.Fatalf("loopback without allow list: %v", err)
	}
}

func TestNewRejectsMalformedFields(t *testing.T) {
	good := map[string]string{"url": "https://dns-hook.example.net/edgeweir?x=1", "secret": secret}
	if _, err := New(good, dnsx.Options{}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []map[string]string{
		{"url": ""},
		{"url": "ftp://dns-hook.example.net/"},
		{"url": "https://user:pw@dns-hook.example.net/"},
		{"url": "https://dns-hook.example.net/#frag"},
		{"url": "https:///path"},
		{"url": "https://dns-hook.example.net:70000/"},
		{"url": "dns-hook.example.net/hook"},
		{"secret": "short-secret-15"},
		{"secret": ""},
	} {
		fields := map[string]string{}
		for k, v := range good {
			fields[k] = v
		}
		for k, v := range bad {
			fields[k] = v
		}
		_, err := New(fields, dnsx.Options{})
		if !errors.Is(err, dnsx.ErrInvalid) {
			t.Errorf("%v accepted: %v", bad, err)
		} else {
			dnstest.NoSecret(t, err, secret, "short-secret-15", "pw@")
		}
	}
}
