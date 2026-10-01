package volcengine

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Requests and responses follow the Volcengine DNS API reference: ListZones
// https://www.volcengine.com/docs/6758/155100, ListRecords
// https://www.volcengine.com/docs/6758/155109, CreateRecord
// https://www.volcengine.com/docs/6758/155104, UpdateRecord
// https://www.volcengine.com/docs/6758/155106, DeleteRecord
// https://www.volcengine.com/docs/6758/155105, errors
// https://www.volcengine.com/docs/6758/155089 and
// https://www.volcengine.com/docs/6369/68677, signing
// https://www.volcengine.com/docs/6758/155088 and
// https://www.volcengine.com/docs/6369/67270.
const (
	ak = "VOLCENGINETESTACCESSKEY1"
	sk = "TWpBeE9EUXdZVFF4WlRabU5HUmhNRGd3TkRrd01EQXdNREF3TURBPQ=="
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

// signedBy checks that the request carries an HMAC-SHA256 signature over
// exactly what was sent.
func signedBy(t *testing.T, r *http.Request, body []byte) {
	t.Helper()
	if r.URL.RawQuery != canonicalQuery(r.URL.Query()) {
		t.Errorf("query %q is not canonical", r.URL.RawQuery)
	}
	headers := map[string]string{
		"content-type": r.Header.Get("Content-Type"), "host": r.Host,
		"x-content-sha256": r.Header.Get("X-Content-Sha256"), "x-date": r.Header.Get("X-Date"),
	}
	if headers["x-content-sha256"] != sum(body) || headers["x-date"] != "20260930T080000Z" || headers["content-type"] != "application/json" {
		t.Errorf("signed headers %v", headers)
	}
	got := r.Header.Get("Authorization")
	prefix := "HMAC-SHA256 Credential=" + ak + "/20260930/cn-beijing/dns/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature="
	if !strings.HasPrefix(got, prefix) {
		t.Errorf("authorization %q", got)
	}
	if want := authorization(ak, sk, "cn-beijing", "dns", r.Method, r.URL.Path, r.URL.RawQuery, headers, sum(body), at); got != want {
		t.Errorf("signature does not cover the request: %q, want %q", got, want)
	}
}

func action(method, name string, query map[string]string, body any, response string) dnstest.Exchange {
	q := map[string]string{"Action": name, "Version": "2018-08-01"}
	for k, v := range query {
		q[k] = v
	}
	return dnstest.Exchange{Method: method, Path: "/", Query: q, JSON: body, Check: signedBy, Header: map[string]string{"User-Agent": "edgeweir-certd/1"}, Response: response}
}

const meta = `"ResponseMetadata":{"RequestId":"20240908181819018059018216990A45","Action":"X","Version":"2018-08-01","Service":"dns","Region":"cn-beijing"}`

func zoneLookup() dnstest.Exchange {
	return zoneLookupAnswer(`{` + meta + `,"Result":{"Total":1,"Zones":[{"CreatedAt":"2022-11-01T10:20:03+08:00","UpdatedAt":"2022-11-01T10:20:03+08:00","ZID":304092,"ZoneName":"example.com","InstanceID":null,"Remark":"","ConfigurationCode":"free","RecordCount":4,"ExpiredTime":0,"LastOperator":"2100098272","CacheStage":0,"TradeCode":"free_inner","DnsSecurity":"","IsSubDomain":false,"ProjectName":"default","Tags":[]}]}}`)
}

func zoneLookupAnswer(response string) dnstest.Exchange {
	return action("GET", "ListZones", map[string]string{"Key": "example.com", "SearchMode": "exact", "PageNumber": "1", "PageSize": "500"}, nil, response)
}

func rec(id, host, typ, value, line string, ttl int) string {
	return `{"RecordID":"` + id + `","FQDN":"` + host + `.example.com","PQDN":"` + host + `.example.com","Host":"` + host + `","Type":"` + typ +
		`","TTL":` + strconv.Itoa(ttl) + `,"Line":"` + line + `","Value":"` + value + `","Weight":1,"Enable":true,"Tags":[],"Remark":"","CreatedAt":"2022-11-09T10:05:08+08:00","UpdatedAt":"2022-11-09T10:05:08+08:00","Operators":["2100xxxx011"]}`
}

func records(page, total int, recs ...string) dnstest.Exchange {
	return action("GET", "ListRecords", map[string]string{"ZID": "304092", "PageNumber": strconv.Itoa(page), "PageSize": "500"}, nil,
		`{`+meta+`,"Result":{"PageNumber":`+strconv.Itoa(page)+`,"PageSize":500,"Records":[`+strings.Join(recs, ",")+`],"TotalCount":`+strconv.Itoa(total)+`}}`)
}

var existing = []string{
	rec("10", "www", "A", "192.0.2.1", "default", 600),
	rec("11", "www", "A", "192.0.2.2", "default", 600),
	rec("12", "www", "A", "192.0.2.1", "telecom", 600),
	rec("13", "@", "TXT", "keep", "default", 600),
}

func TestSignatureKnownAnswer(t *testing.T) {
	// The worked example of "签名过程Demo" (IAM ListUsers).
	query := canonicalQuery(url.Values{"Action": {"ListUsers"}, "Version": {"2018-01-01"}, "Limit": {"10"}, "Offset": {"0"}})
	if query != "Action=ListUsers&Limit=10&Offset=0&Version=2018-01-01" {
		t.Fatalf("canonical query %s", query)
	}
	got := authorization("VOLCENGINETESTACCESSKEY2", "WkRZeE1EQmxPVGhsWWpWak5HVmtNbUUxTXpZeU9UVXlOMlE1TmpZeVlqTQ==",
		"cn-beijing", "iam", "GET", "/", query, map[string]string{"host": "iam.volcengineapi.com", "x-date": "20240619T071306Z"}, sum(nil),
		time.Date(2024, 6, 19, 7, 13, 6, 0, time.UTC))
	want := "HMAC-SHA256 Credential=VOLCENGINETESTACCESSKEY2/20240619/cn-beijing/iam/request, SignedHeaders=host;x-date, Signature=e31c4558bcfe08a286001f59cedbf0791ffd0b2362f10e55ee2627467bcdde93"
	if got != want {
		t.Fatalf("authorization %s", got)
	}
	if canonicalQuery(url.Values{"Key": {"a b+c"}}) != "Key=a%20b%2Bc" {
		t.Fatal("spaces must be %20")
	}
}

func TestGetRecordsPaginates(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(),
		records(1, 3, rec("10", "www", "A", "192.0.2.1", "default", 600), rec("11", "@", "MX", "10 mail.example.com", "default", 600)),
		records(2, 3, rec("12", "_acme-challenge", "TXT", "token", "default", 600)),
	)
	got, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || !dnstest.Has(got, "www", "A", "192.0.2.1") || !dnstest.Has(got, "@", "MX", "10 mail.example.com") ||
		!dnstest.Has(got, "_acme-challenge", "TXT", "token") || got[0].RR().TTL != 600*time.Second {
		t.Fatalf("records: %+v", got)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(),
		action("POST", "CreateRecord", nil, map[string]any{"ZID": 304092, "Host": "_acme-challenge.cdn", "Type": "TXT", "Value": "token", "TTL": 600, "Line": "default"},
			`{`+meta+`,"Result":`+rec("20", "_acme-challenge.cdn", "TXT", "token", "default", 600)+`}`),
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{dnstest.TXT("_acme-challenge.cdn", "token", 600)})
	if err != nil || len(done) != 1 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsReplacesTheRRset(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(),
		records(1, 4, existing...),
		// 192.0.2.1 on the default line stays with a new TTL, 192.0.2.2 and the
		// telecom-line copy go, 192.0.2.3 is created; the TXT is untouched.
		action("POST", "UpdateRecord", nil, map[string]any{"RecordID": "10", "Host": "www", "Line": "default", "Type": "A", "Value": "192.0.2.1", "TTL": 60},
			`{`+meta+`,"Result":`+rec("10", "www", "A", "192.0.2.1", "default", 60)+`}`),
		action("POST", "DeleteRecord", nil, map[string]any{"RecordID": "11"}, `{`+meta+`}`),
		action("POST", "DeleteRecord", nil, map[string]any{"RecordID": "12"}, `{`+meta+`}`),
		action("POST", "CreateRecord", nil, map[string]any{"ZID": 304092, "Host": "www", "Type": "A", "Value": "192.0.2.3", "TTL": 60, "Line": "default"},
			`{`+meta+`,"Result":`+rec("21", "www", "A", "192.0.2.3", "default", 60)+`}`),
	)
	_, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60),
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(),
		records(1, 4, existing...),
		action("POST", "DeleteRecord", nil, map[string]any{"RecordID": "11"}, `{`+meta+`}`),
		action("POST", "DeleteRecord", nil, map[string]any{"RecordID": "13"}, `{`+meta+`}`),
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
		action("GET", "ListZones", map[string]string{"PageNumber": "1", "PageSize": "500", "Key": ""}, nil,
			`{`+meta+`,"Result":{"Total":2,"Zones":[{"ZID":2636,"ZoneName":"example.com","TradeCode":"free_inner"}]}}`),
		action("GET", "ListZones", map[string]string{"PageNumber": "2", "PageSize": "500"}, nil,
			`{`+meta+`,"Result":{"Total":2,"Zones":[{"ZID":1376,"ZoneName":"Example.NET","TradeCode":"free_inner"}]}}`),
	)
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func failure(status int, code, codeN, message string) dnstest.Exchange {
	e := zoneLookup()
	e.Status = status
	e.Response = `{"ResponseMetadata":{"RequestId":"2023041116283931DC4B51E4C8C7660227","Action":"ListZones","Version":"2018-08-01","Service":"dns","Region":"cn-beijing","Error":{"CodeN":` +
		codeN + `,"Code":"` + code + `","Message":"` + message + `"}}}`
	return e
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		failure(401, "InvalidAccessKey", "100009", "The accesskey ["+ak+"] included in the request is invalid."),
		failure(401, "SignatureDoesNotMatch", "100010", "The request signature we calculated does not match the signature you provided."),
		zoneLookupAnswer(`{`+meta+`,"Result":{"Total":0,"Zones":[]}}`),
		zoneLookup(),
		func() dnstest.Exchange {
			e := records(1, 0)
			e.Status = 400
			e.Response = `{"ResponseMetadata":{"RequestId":"1","Action":"ListRecords","Version":"2018-08-01","Service":"dns","Region":"cn-beijing","Error":{"CodeN":400105,"Code":"ErrZoneNotFound","Message":"zone not found"}}}`
			return e
		}(),
		failure(429, "FlowLimitExceeded", "100018", "Request was rejected because the request speed of this openAPI is beyond the current flow control limit."),
		failure(500, "InternalError", "100014", "Service has some internal Error. Pls Contact With Admin."),
		func() dnstest.Exchange { e := zoneLookup(); e.Status = 502; e.Response = "bad gateway"; return e }(),
	)
	p := provider(t, s)
	ctx := context.Background()
	_, err := p.GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, ak, sk)
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("invalid access key: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrAuth) {
		t.Fatalf("signature mismatch: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("zone not in the account: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("ErrZoneNotFound: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrRateLimited) {
		t.Fatalf("flow limit: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	_, err = p.GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, ak, sk)
	if dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx without JSON: %v", err)
	}
	for _, fields := range []map[string]string{
		{"access_key_id": "AKLT", "secret_access_key": sk},
		{"access_key_id": ak + "/x", "secret_access_key": sk},
		{"access_key_id": ak, "secret_access_key": ""},
		{"access_key_id": ak, "secret_access_key": "has space"},
	} {
		if _, err := New(fields, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed credentials accepted: %v", err)
		}
	}
}
