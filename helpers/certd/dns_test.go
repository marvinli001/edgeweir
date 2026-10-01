package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

func TestEveryCatalogProviderHasAnAdapter(t *testing.T) {
	var ids []string
	for id := range catalog {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if strings.Join(ids, ",") != strings.Join(providerIDs(), ",") {
		t.Fatalf("catalog %v\nadapters %v", ids, providerIDs())
	}
}

func TestProviderRegionCannotChangeDestination(t *testing.T) {
	for _, region := range []string{"cn-north-4@127.0.0.1/#", "../metadata", "cn-north-4/path"} {
		credentials, _ := json.Marshal(map[string]string{"access_key_id": "test", "secret_access_key": "test", "region_id": region})
		if _, err := providerFor(dnsParams{Provider: "huaweicloud", Credentials: credentials}); err == nil {
			t.Fatalf("accepted unsafe region %q", region)
		}
	}
	if _, err := providerFor(dnsParams{Provider: "huaweicloud", Credentials: json.RawMessage(`{"access_key_id":"test","secret_access_key":"test","region_id":"cn-north-4"}`)}); err != nil {
		t.Fatal(err)
	}
}

func TestCredentialFieldsFollowTheCatalog(t *testing.T) {
	token := "0123456789abcdefghij"
	cases := []struct {
		provider string
		fields   string
		ok       bool
	}{
		{"cloudflare", `{"api_token":"` + token + `"}`, true},
		{"cloudflare", `{"api_token":"` + token + `","zone_token":""}`, true},
		{"cloudflare", `{"zone_token":"` + token + `"}`, false},            // required missing
		{"cloudflare", `{"api_token":"` + token + `","other":"x"}`, false}, // unknown key
		{"cloudflare", `{"api_token":"short"}`, false},                     // pattern
		{"cloudflare", `{"api_token":"0123456789abcdefghi\u0000"}`, false}, // control character
		{"ovh", `{"endpoint":"ovh-mars","application_key":"abcdefgh","application_secret":"abcdefgh","consumer_key":"abcdefgh"}`, false},
		{"ovh", `{"endpoint":"ovh-ca","application_key":"abcdefgh","application_secret":"abcdefgh","consumer_key":"abcdefgh"}`, true},
		{"webhook", `{"url":"https://u:p@hook.test/","secret":"0123456789abcdef"}`, false},
		{"webhook", `{"url":"ftp://hook.test/","secret":"0123456789abcdef"}`, false},
		{"webhook", `{"url":"https://hook.test/x?y=1","secret":"0123456789abcdef"}`, true},
		{"googleclouddns", `{"service_account_json":"{\n \"type\": \"service_account\"\n}"}`, true},
		{"nope", `{}`, false},
		{"cloudflare", `not json`, false},
	}
	for _, c := range cases {
		_, err := credentialFields(c.provider, json.RawMessage(c.fields))
		if (err == nil) != c.ok {
			t.Errorf("%s %s: err %v, want ok=%v", c.provider, c.fields, err, c.ok)
		}
		if err != nil && strings.Contains(err.Error(), token) {
			t.Errorf("error quotes the credential: %v", err)
		}
	}
	fields, err := credentialFields("powerdns", json.RawMessage(`{"server_url":"https://pdns.test:8081","api_key":"k"}`))
	if err != nil || fields["server_id"] != "localhost" {
		t.Fatalf("optional default: %v %v", fields, err)
	}
}

func TestDNSCommandsClassifyErrors(t *testing.T) {
	resp, code := call(t, `{"command":"dns.zones","params":{"provider":"rfc2136","credentials":{"server":"ns1.test","tsig_key_name":"k","tsig_algorithm":"hmac-sha256","tsig_secret":"c2VjcmV0"}}}`)
	if code == 0 || resp.Code != "dns_unsupported" {
		t.Fatalf("zones without listing: %+v", resp)
	}
	resp, _ = call(t, `{"command":"dns.list","params":{"provider":"cloudflare","zone":"example.com","credentials":{"api_token":"short"}}}`)
	if resp.OK || resp.Code != "dns_invalid_request" {
		t.Fatalf("invalid credentials: %+v", resp)
	}
	resp, _ = call(t, `{"command":"dns.set","params":{"provider":"test","zone":"example.com","credentials":{"api_token":"t"},"records":[{"name":"x","type":"MX","data":"10 mx","ttl":60}]}}`)
	if resp.OK || resp.Code != "dns_invalid_request" || !strings.Contains(resp.Error, "record type") {
		t.Fatalf("record type: %+v", resp)
	}
	resp, _ = call(t, `{"command":"dns.list","params":{"provider":"test","zone":"example.com","credentials":{"api_token":"t"},"outbound":{"allowCidrs":["not-a-cidr"]}}}`)
	if resp.OK || resp.Code != "dns_invalid_request" {
		t.Fatalf("allow list: %+v", resp)
	}
}

func TestDNSTestAndZonesThroughTheFixture(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer e2e" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/dns/list":
			_, _ = w.Write([]byte(`[{"name":"a","type":"A","data":"192.0.2.1","ttl":60},{"name":"b","type":"TXT","data":"x","ttl":60}]`))
		case "/dns/zones":
			_, _ = w.Write([]byte(`["b.test","a.test."]`))
		}
	}))
	defer server.Close()
	t.Setenv("EDGEWEIR_DNS_TEST_ENDPOINT", server.URL)
	resp, code := call(t, `{"command":"dns.test","params":{"provider":"test","zone":"a.test","credentials":{"api_token":"e2e"}}}`)
	if code != 0 || !resp.OK {
		t.Fatalf("test: %+v", resp)
	}
	if raw, _ := json.Marshal(resp.Result); string(raw) != `{"records":2}` {
		t.Fatalf("test result %s", raw)
	}
	resp, _ = call(t, `{"command":"dns.zones","params":{"provider":"test","credentials":{"api_token":"e2e"}}}`)
	if raw, _ := json.Marshal(resp.Result); string(raw) != `["a.test","b.test"]` {
		t.Fatalf("zones %s", raw)
	}
	resp, _ = call(t, `{"command":"dns.test","params":{"provider":"test","zone":"a.test","credentials":{"api_token":"wrong"}}}`)
	if resp.OK || resp.Code != "dns_auth_failed" {
		t.Fatalf("auth: %+v", resp)
	}
}

func TestErrorCodes(t *testing.T) {
	for err, want := range map[error]string{
		dnsx.ErrRefused:                            "dns_address_refused",
		&dnsx.StatusError{Status: 403}:             "dns_auth_failed",
		&dnsx.StatusError{Status: 404}:             "dns_zone_not_found",
		&dnsx.StatusError{Status: 429}:             "dns_rate_limited",
		&dnsx.StatusError{Status: 503}:             "dns_provider_unreachable",
		errors.New("anything else"):                "dns_provider_error",
		errors.Join(errors.New("x"), dnsx.ErrAuth): "dns_auth_failed",
	} {
		if got := dnsx.Code(err); got != want {
			t.Errorf("%v: %s, want %s", err, got, want)
		}
	}
}

func TestRecordNamesAndZonesAreChecked(t *testing.T) {
	for _, c := range []struct{ zone, name string }{
		{"example.com", ""},                 // an empty name would mean the apex to some APIs
		{"example.com", "www.example.com."}, // absolute
		{"example.com", "a..b"},             // empty label
		{"example.com", "a/b"},              // path
		{"example.com?x=1", "www"},          // query characters in the zone
		{"example com", "www"},
		{"-bad.example", "www"},
	} {
		body, _ := json.Marshal(map[string]any{"command": "dns.set", "params": map[string]any{
			"provider": "test", "zone": c.zone, "credentials": map[string]string{"api_token": "t"},
			"records": []map[string]any{{"name": c.name, "type": "TXT", "data": "x", "ttl": 60}},
		}})
		resp, _ := call(t, string(body))
		if resp.OK || resp.Code != "dns_invalid_request" {
			t.Errorf("zone %q name %q accepted: %+v", c.zone, c.name, resp)
		}
	}
	for _, name := range []string{"@", "*", "*.img", "_acme-challenge", "_edgeweir-verification.shop", "a-b.c_d"} {
		if !recordName.MatchString(name) {
			t.Errorf("valid name %q refused", name)
		}
	}
}

func TestLineAdaptersMatchTheCatalog(t *testing.T) {
	for id, entry := range catalog {
		want := []string{dnsx.DefaultLine}
		if m, ok := lineMaps[id]; ok {
			want = m.Lines()
		}
		if strings.Join(entry.Capabilities.Lines, ",") != strings.Join(want, ",") {
			t.Errorf("%s: catalog lines %v, adapter lines %v", id, entry.Capabilities.Lines, want)
		}
	}
	for id := range lineMaps {
		if _, ok := catalog[id]; !ok {
			t.Errorf("%s has lines but no catalog entry", id)
		}
	}
}

func TestDNSRecordsCarryLines(t *testing.T) {
	var bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		bodies = append(bodies, r.URL.Path+" "+string(raw))
		switch r.URL.Path {
		case "/dns/list":
			_, _ = w.Write([]byte(`[{"name":"all","type":"A","data":"192.0.2.1","ttl":600,"line":"default"},{"name":"all","type":"A","data":"192.0.2.2","ttl":600,"line":"telecom"},{"name":"www","type":"A","data":"192.0.2.3","ttl":600}]`))
		default:
			_, _ = w.Write([]byte(`[]`))
		}
	}))
	defer server.Close()
	t.Setenv("EDGEWEIR_DNS_TEST_ENDPOINT", server.URL)
	result, err := dnsCommand(context.Background(), "dns.list", json.RawMessage(`{"provider":"test","zone":"a.test","credentials":{"api_token":"e2e"}}`))
	if err != nil {
		t.Fatal(err)
	}
	// The wire form: the default line is omitted, other lines carry their canonical id.
	raw, _ := json.Marshal(result)
	if string(raw) != `[{"name":"all","type":"A","data":"192.0.2.1","ttl":600},{"name":"all","type":"A","data":"192.0.2.2","ttl":600,"line":"telecom"},{"name":"www","type":"A","data":"192.0.2.3","ttl":600}]` {
		t.Fatalf("list %s", raw)
	}
	resp, _ := call(t, `{"command":"dns.set","params":{"provider":"test","zone":"a.test","credentials":{"api_token":"e2e"},"records":[{"name":"all","type":"A","data":"192.0.2.1","ttl":600,"line":"default"},{"name":"all","type":"A","data":"192.0.2.5","ttl":600,"line":"overseas"}]}}`)
	if !resp.OK {
		t.Fatalf("set: %+v", resp)
	}
	resp, _ = call(t, `{"command":"dns.cleanup","params":{"provider":"test","zone":"a.test","credentials":{"api_token":"e2e"},"records":[{"name":"all","type":"A","data":"192.0.2.9","ttl":600,"line":"other:10=4"}]}}`)
	if !resp.OK {
		t.Fatalf("cleanup of a provider line: %+v", resp)
	}
	want := []string{
		`/dns/list {"zone":"a.test","records":null}`,
		`/dns/set {"zone":"a.test","records":[{"name":"all","type":"A","data":"192.0.2.1","ttl":600},{"name":"all","type":"A","data":"192.0.2.5","ttl":600,"line":"overseas"}]}`,
		`/dns/delete {"zone":"a.test","records":[{"name":"all","type":"A","data":"192.0.2.9","ttl":600,"line":"other:10=4"}]}`,
	}
	if strings.Join(bodies, "\n") != strings.Join(want, "\n") {
		t.Fatalf("requests\n%s\nwant\n%s", strings.Join(bodies, "\n"), strings.Join(want, "\n"))
	}
}

func TestDNSLinesAreChecked(t *testing.T) {
	record := func(provider, command, credentials, line string) string {
		return `{"command":"` + command + `","params":{"provider":"` + provider + `","zone":"example.com","credentials":` + credentials +
			`,"records":[{"name":"all","type":"A","data":"192.0.2.1","ttl":600,"line":"` + line + `"}]}}`
	}
	cloudflare := `{"api_token":"0123456789abcdefghij"}`
	for _, c := range []struct {
		provider, command, credentials, line, code string
	}{
		// Default-line providers refuse other lines before any request.
		{"cloudflare", "dns.set", cloudflare, "telecom", "dns_unsupported"},
		{"cloudflare", "dns.present", cloudflare, "overseas", "dns_unsupported"},
		{"route53", "dns.set", `{"access_key_id":"AKIAIOSFODNN7EXAMPLE","secret_access_key":"secret"}`, "unicom", "dns_unsupported"},
		{"cloudflare", "dns.cleanup", cloudflare, "other:10=4", "dns_unsupported"},
		// Names that are not canonical lines are invalid everywhere.
		{"dnspod", "dns.set", `{"auth_token":"12345,0123456789abcdef"}`, "satellite", "dns_invalid_request"},
		{"dnspod", "dns.set", `{"auth_token":"12345,0123456789abcdef"}`, "10=0", "dns_invalid_request"},
		{"alidns", "dns.set", `{"access_key_id":"id","access_key_secret":"s"}`, "oversea", "dns_invalid_request"},
		// Provider lines without a canonical id can only be deleted.
		{"dnspod", "dns.set", `{"auth_token":"12345,0123456789abcdef"}`, "other:10=4", "dns_invalid_request"},
		{"dnspod", "dns.cleanup", `{"auth_token":"12345,0123456789abcdef"}`, "other:", "dns_invalid_request"},
		{"dnspod", "dns.cleanup", `{"auth_token":"12345,0123456789abcdef"}`, "other:a b", "dns_invalid_request"},
	} {
		resp, _ := call(t, record(c.provider, c.command, c.credentials, c.line))
		if resp.OK || resp.Code != c.code {
			t.Errorf("%s %s line %q: %+v, want %s", c.provider, c.command, c.line, resp, c.code)
		}
	}
}
