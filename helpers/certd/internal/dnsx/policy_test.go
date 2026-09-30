package dnsx

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestAllowed(t *testing.T) {
	allow := []netip.Prefix{netip.MustParsePrefix("10.8.0.0/16")}
	for ip, want := range map[string]bool{
		"8.8.8.8":          true,
		"2606:4700::1111":  true,
		"127.0.0.1":        false,
		"10.8.1.2":         true, // allowed private range
		"10.9.1.2":         false,
		"169.254.169.254":  false, // cloud metadata
		"::1":              false,
		"::ffff:127.0.0.1": false, // judged by the embedded IPv4 address
		"64:ff9b::a08:102": true,  // NAT64 of 10.8.1.2
		"64:ff9b::7f00:1":  false,
		"fe80::1":          false,
		"fd00::1":          false,
		"100.64.0.1":       false,
		"198.51.100.1":     false,
	} {
		if got := Allowed(netip.MustParseAddr(ip), allow); got != want {
			t.Errorf("%s: %v, want %v", ip, got, want)
		}
	}
}

func TestPolicyClientRefusesSpecialAndCleartextPublic(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	// Loopback without an allow list: refused before any byte is sent.
	_, _, err := Do(Options{}.PolicyClient(), mustRequest(t, server.URL))
	if !errors.Is(err, ErrRefused) || Code(err) != "dns_address_refused" {
		t.Fatalf("loopback: %v", err)
	}
	// Allowed LAN address: cleartext HTTP is fine.
	status, _, err := Do(Options{AllowCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}}.PolicyClient(), mustRequest(t, server.URL))
	if err != nil || status != http.StatusNoContent {
		t.Fatalf("allowed: %d %v", status, err)
	}
	// Cleartext to a public address is refused at connect time.
	dialer := PolicyDialer(nil, true)
	if err := dialer.Control("tcp", "8.8.8.8:80", nil); !errors.Is(err, ErrRefused) {
		t.Fatalf("cleartext public: %v", err)
	}
	if err := PolicyDialer(nil, false).Control("tcp", "8.8.8.8:443", nil); err != nil {
		t.Fatalf("TLS public: %v", err)
	}
	if _, err := DialPolicy(context.Background(), nil, "tcp", server.Listener.Addr().String()); !errors.Is(err, ErrRefused) {
		t.Fatalf("dns dial: %v", err)
	}
}

func mustRequest(t *testing.T, url string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func TestRecordHelpers(t *testing.T) {
	if Relative("WWW.Example.com.", "example.com.") != "www" || Relative("example.com", "example.com.") != "@" {
		t.Fatal("relative names")
	}
	if Unquote(`"a" "b\"c"`) != `ab"c` {
		t.Fatalf("unquote: %q", Unquote(`"a" "b\"c"`))
	}
	if CanonicalData("CNAME", "Target.Example.COM.") != "target.example.com" {
		t.Fatal("canonical CNAME")
	}
}
