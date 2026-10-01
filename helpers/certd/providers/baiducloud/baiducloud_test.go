package baiducloud

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Requests and responses follow the Baidu AI Cloud DNS API reference:
// records https://cloud.baidu.com/doc/DNS/s/El4s7lssr, zones
// https://cloud.baidu.com/doc/DNS/s/kl4s7g11z, errors
// https://cloud.baidu.com/doc/DNS/s/lkk5elv58, signing
// https://cloud.baidu.com/doc/Reference/s/njwvz1yfu.
const (
	ak = "0123456789abcdef0123456789abcdef"
	sk = "fedcba9876543210fedcba9876543210"
)

var at = time.Date(2026, 9, 30, 8, 0, 0, 0, time.UTC)

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	p, err := New(map[string]string{"access_key_id": ak, "secret_access_key": sk}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	p.(*Provider).now = func() time.Time { return at }
	return p.(*Provider)
}

// signedBy checks that the request carries a bce-auth-v1 signature over
// exactly what was sent.
func signedBy(t *testing.T, r *http.Request, body []byte) {
	t.Helper()
	headers := map[string]string{"host": r.Host, "x-bce-date": r.Header.Get("x-bce-date")}
	prefix := "bce-auth-v1/" + ak + "/2026-09-30T08:00:00Z/1800/host;x-bce-date/"
	if len(body) > 0 {
		headers["content-type"] = r.Header.Get("Content-Type")
		prefix = "bce-auth-v1/" + ak + "/2026-09-30T08:00:00Z/1800/content-type;host;x-bce-date/"
		if headers["content-type"] != "application/json; charset=utf-8" {
			t.Errorf("content type %q", headers["content-type"])
		}
	}
	got := r.Header.Get("Authorization")
	if headers["x-bce-date"] != "2026-09-30T08:00:00Z" || !strings.HasPrefix(got, prefix) {
		t.Errorf("authorization %q, x-bce-date %q", got, headers["x-bce-date"])
	}
	if want := authorization(ak, sk, r.Method, r.URL.Path, r.URL.Query(), headers, at, true); got != want {
		t.Errorf("signature does not cover the request: %q, want %q", got, want)
	}
}

// failing is a record list answered with an error.
func failing(status int, response string) dnstest.Exchange {
	e := listCall(nil, response)
	e.Status = status
	return e
}

func listCall(query map[string]string, response string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "GET", Path: "/v1/dns/zone/example.com/record", Query: query,
		Header: map[string]string{"User-Agent": "edgeweir-certd/1", "Content-Type": ""}, Check: signedBy, Response: response,
	}
}

const existing = `{"marker":"","maxKeys":1000,"isTruncated":false,"records":[
{"id":"10","rr":"www","status":"running","type":"A","value":"192.0.2.1","ttl":300,"line":"default","description":""},
{"id":"11","rr":"www","status":"running","type":"A","value":"192.0.2.2","ttl":300,"line":"default","description":""},
{"id":"12","rr":"www","status":"running","type":"A","value":"192.0.2.1","ttl":300,"line":"ct","description":""},
{"id":"13","rr":"@","status":"running","type":"TXT","value":"keep","ttl":300,"line":"default","description":""}]}`

func TestSignatureKnownAnswer(t *testing.T) {
	// The worked example of "生成认证字符串" (BOS UploadPart, default signed headers).
	headers := map[string]string{
		"Host": "bj.bcebos.com", "Content-Type": "text/plain", "Content-Length": "8",
		"Content-Md5": "NFzcPqhviddjRNnSOGo4rw==", "x-bce-date": "2015-04-27T08:23:49Z",
	}
	query := url.Values{"partNumber": {"9"}, "uploadId": {"a44cc9bab11cbd156984767aad637851"}}
	got := authorization(strings.Repeat("a", 32), strings.Repeat("b", 32), "PUT", "/v1/test/myfolder/readme.txt", query, headers,
		time.Date(2015, 4, 27, 8, 23, 49, 0, time.UTC), false)
	want := "bce-auth-v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/2015-04-27T08:23:49Z/1800//d74a04362e6a848f5b39b15421cb449427f419c95a480fd6b8cf9fc783e2999e"
	if got != want {
		t.Fatalf("authorization %s", got)
	}
	// The CanonicalQueryString example of the same page.
	q := canonicalQuery(url.Values{"text": {""}, "text1": {"测试"}, "text10": {"test"}})
	if q != "text10=test&text1=%E6%B5%8B%E8%AF%95&text=" {
		t.Fatalf("canonical query %s", q)
	}
	if uriEncode("/example/测试", true) != "/example/%E6%B5%8B%E8%AF%95" {
		t.Fatal("UriEncodeExceptSlash")
	}
}

func TestGetRecordsFollowsMarkers(t *testing.T) {
	s := dnstest.Serve(t,
		listCall(map[string]string{"maxKeys": "1000", "marker": ""}, `{"nextMarker":"m2","marker":"","maxKeys":1000,"isTruncated":true,"records":[
{"id":"10","rr":"www","status":"running","type":"A","value":"192.0.2.1","ttl":300,"line":"default","description":""},
{"id":"11","rr":"@","status":"running","type":"MX","value":"mail.example.com","ttl":600,"line":"default","priority":10}]}`),
		listCall(map[string]string{"maxKeys": "1000", "marker": "m2"}, `{"marker":"m2","maxKeys":1000,"isTruncated":false,"records":[
{"id":"12","rr":"_acme-challenge","status":"running","type":"TXT","value":"token","ttl":300,"line":"default"}]}`),
	)
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 3 || !dnstest.Has(records, "www", "A", "192.0.2.1") || !dnstest.Has(records, "@", "MX", "10 mail.example.com") ||
		!dnstest.Has(records, "_acme-challenge", "TXT", "token") {
		t.Fatalf("records: %+v", records)
	}
	if records[1].RR().TTL != 600*time.Second {
		t.Fatalf("ttl: %v", records[1].RR().TTL)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{
			Method: "POST", Path: "/v1/dns/zone/example.com/record", Check: signedBy,
			JSON: map[string]any{"rr": "_acme-challenge.cdn", "type": "TXT", "value": "token", "ttl": 300, "line": "default"},
		},
		dnstest.Exchange{
			Method: "POST", Path: "/v1/dns/zone/example.com/record", Check: signedBy,
			JSON: map[string]any{"rr": "@", "type": "MX", "value": "mail.example.com", "ttl": 600, "line": "default", "priority": 10},
		},
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge.cdn", "token", 300), libdns.RR{Name: "@", Type: "MX", Data: "10 mail.example.com", TTL: 600 * time.Second},
	})
	if err != nil || len(done) != 2 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsReplacesTheRRset(t *testing.T) {
	s := dnstest.Serve(t,
		listCall(nil, existing),
		// 192.0.2.1 on the default line stays with a new TTL, 192.0.2.2 and the
		// telecom-line copy go, 192.0.2.3 is created; the TXT is untouched.
		dnstest.Exchange{Method: "PUT", Path: "/v1/dns/zone/example.com/record/10", Check: signedBy,
			JSON: map[string]any{"rr": "www", "type": "A", "value": "192.0.2.1", "ttl": 60}},
		dnstest.Exchange{Method: "DELETE", Path: "/v1/dns/zone/example.com/record/11", Check: signedBy},
		dnstest.Exchange{Method: "DELETE", Path: "/v1/dns/zone/example.com/record/12", Check: signedBy},
		dnstest.Exchange{Method: "POST", Path: "/v1/dns/zone/example.com/record", Check: signedBy,
			JSON: map[string]any{"rr": "www", "type": "A", "value": "192.0.2.3", "ttl": 60, "line": "default"}},
	)
	_, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60),
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(s.Requests[1].Body), `"line"`) {
		t.Fatalf("update carries a line: %s", s.Requests[1].Body)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		listCall(nil, existing),
		dnstest.Exchange{Method: "DELETE", Path: "/v1/dns/zone/example.com/record/11", Check: signedBy},
		dnstest.Exchange{Method: "DELETE", Path: "/v1/dns/zone/example.com/record/13", Check: signedBy},
	)
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 0), libdns.RR{Name: "@", Type: "TXT"},
	})
	if err != nil || len(deleted) != 2 || !dnstest.Has(deleted, "@", "TXT", "keep") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/v1/dns/zone", Query: map[string]string{"maxKeys": "1000", "marker": ""}, Check: signedBy,
			Response: `{"nextMarker":"5678","marker":"","maxKeys":1000,"isTruncated":true,"zones":[{"id":"1234","name":"example.com","status":"running","productVersion":"free","createTime":"2022-04-27 20:19:58","expireTime":"2023-04-27 20:19:58","tags":[]}]}`},
		dnstest.Exchange{Method: "GET", Path: "/v1/dns/zone", Query: map[string]string{"maxKeys": "1000", "marker": "5678"}, Check: signedBy,
			Response: `{"marker":"5678","maxKeys":1000,"isTruncated":false,"zones":[{"id":"1235","name":"Example.NET","status":"running","productVersion":"discount"}]}`},
	)
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		failing(403, `{"code":"AccessDenied","message":"Access denied.","requestId":"c4abab14-ebc4-4eb0-85d2-03c4d51eed18"}`),
		failing(400, `{"code":"SignatureDoesNotMatch","message":"The request signature we calculated does not match the signature you provided. `+ak+`","requestId":"c4abab14"}`),
		failing(404, `{"code":"NoSuchObject","message":"zone not exist","requestId":"c4abab14"}`),
		failing(500, `{"code":"InternalError","message":"We encountered an internal error Please try again.","requestId":"c4abab14"}`),
	)
	p := provider(t, s)
	_, err := p.GetRecords(context.Background(), "example.com.")
	dnstest.NoSecret(t, err, ak, sk)
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("access denied: %v", err)
	}
	_, err = p.GetRecords(context.Background(), "example.com.")
	dnstest.NoSecret(t, err, ak, sk)
	if dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("signature mismatch (HTTP 400): %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	if _, err := p.SetRecords(context.Background(), "example.com.", []libdns.Record{libdns.RR{Name: "@", Type: "CAA", Data: `0 issue "ca.example"`}}); !errors.Is(err, dnsx.ErrUnsupported) {
		t.Fatalf("unsupported type: %v", err)
	}
	if _, err := p.AppendRecords(context.Background(), "example.com.", []libdns.Record{libdns.RR{Name: "@", Type: "MX", Data: "mail.example.com"}}); !errors.Is(err, dnsx.ErrInvalid) {
		t.Fatalf("MX without priority: %v", err)
	}
	for _, fields := range []map[string]string{
		{"access_key_id": "short", "secret_access_key": sk},
		{"access_key_id": ak + " ", "secret_access_key": sk},
		{"access_key_id": ak, "secret_access_key": ""},
		{"access_key_id": ak, "secret_access_key": "has space"},
	} {
		if _, err := New(fields, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed credentials accepted: %v", err)
		}
	}
}
