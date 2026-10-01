package huaweicloud

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Responses follow the examples of the Huawei Cloud DNS API reference:
// ListPublicZones https://support.huaweicloud.com/api-dns/dns_api_62003.html,
// ShowRecordSetByZone https://support.huaweicloud.com/api-dns/dns_api_64004.html,
// CreateRecordSetWithLine https://support.huaweicloud.com/api-dns/dns_api_64001.html,
// UpdateRecordSets https://support.huaweicloud.com/api-dns/UpdateRecordSets.html,
// DeleteRecordSets https://support.huaweicloud.com/api-dns/dns_api_64005.html,
// error codes https://support.huaweicloud.com/api-dns/ErrorCode.html. The
// signing example is https://support.huaweicloud.com/devg-apisign/api-sign-algorithm-002.html.
const (
	keyID  = "QTWAOYTTINDUT2QVKYUC"
	secret = "MFyfvK41ba2giqM7Uio6PznpdUKGpownRZlmVmHc"
	zoneID = "2c9eb155587194ec01587224c9f90149"
)

var clock = time.Date(2026, 9, 30, 3, 36, 55, 0, time.UTC)

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	p, err := New(map[string]string{"access_key_id": keyID, "secret_access_key": secret}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	pp := p.(*Provider)
	pp.now = func() time.Time { return clock }
	return pp
}

// signed recomputes the AK/SK signature of a received request.
func signed(t *testing.T, r *http.Request, body []byte) {
	t.Helper()
	if r.Header.Get("X-Sdk-Date") != "20260930T033655Z" {
		t.Errorf("X-Sdk-Date %q", r.Header.Get("X-Sdk-Date"))
	}
	headers := map[string]string{"host": r.Host, "x-sdk-date": "20260930T033655Z"}
	if len(body) > 0 {
		headers["content-type"] = r.Header.Get("Content-Type")
	}
	canonical, signedHeaders := canonicalRequest(r.Method, canonicalURI(r.URL.Path), canonicalQuery(r.URL.Query()), headers, sha256Hex(body))
	if got, want := r.Header.Get("Authorization"), authorization(keyID, secret, canonical, signedHeaders, "20260930T033655Z"); got != want {
		t.Errorf("Authorization = %q, want %q", got, want)
	}
	if !strings.HasPrefix(r.Header.Get("Authorization"), "SDK-HMAC-SHA256 Access="+keyID+", SignedHeaders="+signedHeaders+", Signature=") {
		t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
	}
}

func zoneLookup() dnstest.Exchange {
	return dnstest.Exchange{
		Method: "GET", Path: "/v2/zones", Query: map[string]string{"type": "public", "name": "example.com", "search_mode": "equal"},
		Header: map[string]string{"User-Agent": "edgeweir-certd/1 (DNS records)"}, Check: signed,
		Response: `{"links":{"self":"https://dns.cn-north-4.myhuaweicloud.com/v2/zones?type=public"},"zones":[{"id":"` + zoneID + `","name":"example.com.","description":"This is an example zone.","email":"xx@example.com","ttl":300,"serial":0,"status":"ACTIVE","record_num":2,"zone_type":"public","created_at":"2016-11-17T11:56:03.439","updated_at":"2016-11-17T11:56:05.528"}],"metadata":{"total_count":1}}`,
	}
}

func set(id, name, typ string, ttl int, line string, records ...string) string {
	quoted := make([]string, 0, len(records))
	for _, r := range records {
		quoted = append(quoted, fmt.Sprintf("%q", r))
	}
	return fmt.Sprintf(`{"id":%q,"name":%q,"type":%q,"ttl":%d,"records":[%s],"status":"ACTIVE","zone_id":%q,"zone_name":"example.com.","default":false,"line":%q,"weight":1}`,
		id, name, typ, ttl, strings.Join(quoted, ","), zoneID, line)
}

const system = `{"id":"soa","name":"example.com.","type":"SOA","ttl":300,"records":["ns1.huaweicloud-dns.com. hostmaster.example.com. (1 7200 900 1209600 300)"],"status":"ACTIVE","default":true,"line":"default_view","weight":1},
{"id":"ns","name":"example.com.","type":"NS","ttl":172800,"records":["ns1.huaweicloud-dns.com.","ns1.huaweicloud-dns.cn."],"status":"ACTIVE","default":true,"line":"default_view","weight":1}`

func listCall(offset string, total int, sets ...string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "GET", Path: "/v2.1/zones/" + zoneID + "/recordsets", Query: map[string]string{"limit": "500", "offset": offset}, Check: signed,
		Response: fmt.Sprintf(`{"links":{"self":"https://dns.cn-north-4.myhuaweicloud.com/v2.1/zones/%s/recordsets"},"recordsets":[%s],"metadata":{"total_count":%d}}`, zoneID, strings.Join(sets, ","), total),
	}
}

func TestCanonicalRequestMatchesTheDocumentedExample(t *testing.T) {
	query := url.Values{"marker": {"13551d6b-755d-4757-b956-536f674975c0"}, "limit": {"2"}}
	canonical, signedHeaders := canonicalRequest("GET", canonicalURI("/v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs"), canonicalQuery(query),
		map[string]string{"content-type": "application/json", "host": "service.region.example.com", "x-sdk-date": "20191115T033655Z"}, sha256Hex(nil))
	if signedHeaders != "content-type;host;x-sdk-date" || sha256Hex([]byte(canonical)) != "b25362e603ee30f4f25e7858e8a7160fd36e803bb2dfe206278659d71a9bcd7a" {
		t.Fatalf("canonical request:\n%s", canonical)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("SDK-HMAC-SHA256\n20191115T033655Z\nb25362e603ee30f4f25e7858e8a7160fd36e803bb2dfe206278659d71a9bcd7a"))
	want := "SDK-HMAC-SHA256 Access=" + keyID + ", SignedHeaders=content-type;host;x-sdk-date, Signature=" + hex.EncodeToString(mac.Sum(nil))
	if got := authorization(keyID, secret, canonical, signedHeaders, "20191115T033655Z"); got != want {
		t.Fatalf("authorization %s", got)
	}
	if escape("a b/*~é") != "a%20b%2F%2A~%C3%A9" {
		t.Fatalf("escape %s", escape("a b/*~é"))
	}
}

func TestGetRecordsFollowsPages(t *testing.T) {
	first := []string{system}
	for i := range 498 {
		first = append(first, set(fmt.Sprintf("a%d", i), fmt.Sprintf("h%d.example.com.", i), "A", 300, "default_view", "192.0.2.1"))
	}
	s := dnstest.Serve(t,
		zoneLookup(),
		listCall("0", 501, first...),
		listCall("500", 501, set("t", "_acme-challenge.example.com.", "TXT", 60, "default_view", `"t1"`, `"part1" "part2"`)),
	)
	got, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3+498+2 || !dnstest.Has(got, "h497", "A", "192.0.2.1") || !dnstest.Has(got, "@", "NS", "ns1.huaweicloud-dns.cn.") ||
		!dnstest.Has(got, "_acme-challenge", "TXT", "t1") || !dnstest.Has(got, "_acme-challenge", "TXT", "part1part2") {
		t.Fatalf("records: %d", len(got))
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(),
		listCall("0", 3, system, set("t", "_acme-challenge.example.com.", "TXT", 300, "default_view", `"t1"`)),
		// The TXT RRset exists: the second value joins it with the set's TTL.
		dnstest.Exchange{Method: "PUT", Path: "/v2.1/zones/" + zoneID + "/recordsets/t", Check: signed,
			Header:   map[string]string{"Content-Type": "application/json"},
			JSON:     map[string]any{"name": "_acme-challenge.example.com.", "type": "TXT", "ttl": 300, "records": []string{`"t1"`, `"t2"`}},
			Status:   202,
			Response: `{"id":"t","status":"PENDING_UPDATE","zone_id":"` + zoneID + `"}`},
		dnstest.Exchange{Method: "POST", Path: "/v2.1/zones/" + zoneID + "/recordsets", Check: signed,
			JSON:     map[string]any{"name": "cdn.example.com.", "type": "CNAME", "ttl": 60, "records": []string{"edge.example.net."}},
			Status:   202,
			Response: `{"id":"n","name":"cdn.example.com.","type":"CNAME","ttl":60,"records":["edge.example.net."],"status":"PENDING_CREATE","zone_id":"` + zoneID + `"}`},
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", "t2", 60), dnstest.CNAME("cdn", "edge.example.net", 60),
	})
	if err != nil || len(done) != 2 || done[0].RR().TTL != 300*time.Second {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsReplacesTheRRsets(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(),
		listCall("0", 7, system,
			set("w1", "www.example.com.", "A", 300, "default_view", "192.0.2.1", "192.0.2.2"),
			set("w2", "www.example.com.", "A", 300, "Dianxin", "192.0.2.9"),
			set("txt", "example.com.", "TXT", 300, "default_view", `"keep"`),
			set("c", "cdn.example.com.", "CNAME", 300, "default_view", "old.example.net."),
			set("v6", "api.example.com.", "AAAA", 600, "default_view", "2001:db8::1"),
		),
		// www: .1 kept, .2 replaced by .3, TTL changed; the carrier-line set goes.
		dnstest.Exchange{Method: "PUT", Path: "/v2.1/zones/" + zoneID + "/recordsets/w1", Check: signed, Status: 202,
			JSON: map[string]any{"name": "www.example.com.", "type": "A", "ttl": 60, "records": []string{"192.0.2.1", "192.0.2.3"}}, Response: `{"id":"w1","status":"PENDING_UPDATE"}`},
		dnstest.Exchange{Method: "DELETE", Path: "/v2.1/zones/" + zoneID + "/recordsets/w2", Check: signed, Status: 202,
			Response: `{"id":"w2","name":"www.example.com.","type":"A","ttl":300,"records":["192.0.2.9"],"status":"PENDING_DELETE","default":false}`},
		dnstest.Exchange{Method: "PUT", Path: "/v2.1/zones/" + zoneID + "/recordsets/c", Check: signed, Status: 202,
			JSON: map[string]any{"name": "cdn.example.com.", "type": "CNAME", "ttl": 300, "records": []string{"new.example.net."}}, Response: `{"id":"c","status":"PENDING_UPDATE"}`},
		// api is unchanged; img is created; the TXT RRset is untouched.
		dnstest.Exchange{Method: "POST", Path: "/v2.1/zones/" + zoneID + "/recordsets", Check: signed, Status: 202,
			JSON: map[string]any{"name": "img.example.com.", "type": "A", "ttl": 120, "records": []string{"192.0.2.5", "192.0.2.6"}}, Response: `{"id":"i","status":"PENDING_CREATE"}`},
	)
	_, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60),
		dnstest.CNAME("cdn", "new.example.net", 300), dnstest.AAAA("api", "2001:db8::1", 600),
		dnstest.A("img", "192.0.2.5", 120), dnstest.A("img", "192.0.2.6", 120),
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(),
		listCall("0", 4, system,
			set("w1", "www.example.com.", "A", 300, "default_view", "192.0.2.1", "192.0.2.2"),
			set("t", "_acme-challenge.example.com.", "TXT", 60, "default_view", `"t1"`, `"t2"`)),
		dnstest.Exchange{Method: "PUT", Path: "/v2.1/zones/" + zoneID + "/recordsets/w1", Check: signed, Status: 202,
			JSON: map[string]any{"name": "www.example.com.", "type": "A", "ttl": 300, "records": []string{"192.0.2.1"}}, Response: `{"id":"w1","status":"PENDING_UPDATE"}`},
		dnstest.Exchange{Method: "DELETE", Path: "/v2.1/zones/" + zoneID + "/recordsets/t", Check: signed, Status: 202, Response: `{"id":"t","status":"PENDING_DELETE"}`},
	)
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 60), libdns.RR{Name: "_acme-challenge", Type: "TXT"}, dnstest.A("www", "192.0.2.99", 60),
	})
	if err != nil || len(deleted) != 3 || !dnstest.Has(deleted, "_acme-challenge", "TXT", "t2") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{
		Method: "GET", Path: "/v2/zones", Query: map[string]string{"type": "public", "limit": "500", "offset": "0", "name": ""}, Check: signed,
		Response: `{"links":{"self":"https://dns.cn-north-4.myhuaweicloud.com/v2/zones?type=public&limit=500"},"zones":[{"id":"a","name":"example.com.","zone_type":"public"},{"id":"b","name":"Example.NET.","zone_type":"public"}],"metadata":{"total_count":2}}`,
	})
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/v2/zones", Status: 401,
			Response: `{"error_msg":"Incorrect IAM authentication information: verify aksk signature fail","error_code":"APIGW.0301","request_id":"4f8a"}`},
		dnstest.Exchange{Method: "GET", Path: "/v2/zones", Status: 403,
			Response: `{"code":"DNS.0013","message":"You do not have the permission to perform this operation using the API."}`},
		dnstest.Exchange{Method: "GET", Path: "/v2/zones", Response: `{"zones":[],"metadata":{"total_count":0}}`},
		zoneLookup(),
		dnstest.Exchange{Method: "GET", Path: "/v2.1/zones/" + zoneID + "/recordsets", Status: 404, Response: `{"code":"DNS.0302","message":"This zone does not exist."}`},
		dnstest.Exchange{Method: "GET", Path: "/v2.1/zones/" + zoneID + "/recordsets", Status: 500, Response: `{"code":"DNS.0021","message":"Could not acquire the lock, please try again later."}`},
		dnstest.Exchange{Method: "GET", Path: "/v2.1/zones/" + zoneID + "/recordsets", Status: 502, Response: `bad gateway`},
	)
	p := provider(t, s)
	ctx := context.Background()
	for i := range 2 {
		_, err := p.GetRecords(ctx, "example.com.")
		dnstest.NoSecret(t, err, secret)
		if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
			t.Fatalf("auth failure %d: %v", i, err)
		}
	}
	if _, err := p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("zone missing from the list: %v", err)
	}
	if _, err := p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("zone does not exist: %v", err)
	}
	if _, err := p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_rate_limited" {
		t.Fatalf("lock busy: %v", err)
	}
	if _, err := p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	for _, fields := range []map[string]string{
		{"access_key_id": "", "secret_access_key": secret},
		{"access_key_id": "AK/../x", "secret_access_key": secret},
		{"access_key_id": keyID, "secret_access_key": "two words"},
	} {
		if _, err := New(fields, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed credentials accepted: %v", err)
		}
	}
}

func TestProviderRegionCannotChangeDestination(t *testing.T) {
	for _, region := range []string{
		"cn-north-4@127.0.0.1/#", "../metadata", "cn-north-4/path", "cn-north-4.evil.example", "cn-north-4:8443",
		"CN-NORTH-4", "-cn-north-4", "cn--north", "cn-north-4-", "cn", "cn-north-4 ", "cn-" + strings.Repeat("a", 30),
	} {
		if _, err := New(map[string]string{"access_key_id": keyID, "secret_access_key": secret, "region_id": region}, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("accepted unsafe region %q", region)
		}
	}
	for region, host := range map[string]string{
		"":               "https://dns.cn-north-4.myhuaweicloud.com",
		"cn-south-1":     "https://dns.cn-south-1.myhuaweicloud.com",
		"ap-southeast-3": "https://dns.ap-southeast-3.myhuaweicloud.com",
		"eu-west-101":    "https://dns.eu-west-101.myhuaweicloud.com",
	} {
		p, err := New(map[string]string{"access_key_id": keyID, "secret_access_key": secret, "region_id": region}, dnsx.Options{})
		if err != nil || p.(*Provider).BaseURL != host {
			t.Fatalf("region %q: %v", region, err)
		}
	}
}
