package dnsla

import (
	"context"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Requests and responses follow the DNS.LA API reference
// (https://www.dns.la/docs/ApiDoc): 开发必读, 获取域名, 查询域名列表,
// 查询解析记录列表, 添加/修改/删除解析记录.
const (
	apiID     = "myApiId"
	apiSecret = "mySecret0123456789"
)

var basic = "Basic " + base64.StdEncoding.EncodeToString([]byte(apiID+":"+apiSecret))

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	p, err := New(map[string]string{"api_id": apiID, "api_secret": apiSecret}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return p.(*Provider)
}

func call(method, path string, query map[string]string, body any, data string) dnstest.Exchange {
	header := map[string]string{"Authorization": basic, "User-Agent": "edgeweir-certd/1", "Content-Type": ""}
	if body != nil {
		header["Content-Type"] = "application/json; charset=utf-8"
	}
	return dnstest.Exchange{Method: method, Path: path, Query: query, JSON: body, Header: header, Response: `{"code":200,"msg":"","data":` + data + `}`}
}

func domainLookup() dnstest.Exchange {
	return call("GET", "/api/domain", map[string]string{"domain": "example.com"}, nil,
		`{"id":"85371689655342080","createdAt":1692856597,"updatedAt":1692856598,"userId":"85068081529119744","userAccount":"foo@foo.com","assetId":"","groupId":"","groupName":"","domain":"example.com.","displayDomain":"example.com.","state":1,"nsState":3,"nsCheckedAt":1692856598,"productCode":"","productName":"","expiredAt":4102416000,"quoteDomainId":"","quoteDomain":"","suffix":"com.","displaySuffix":"com."}`)
}

func rec(id, host string, typ int, data, lineID string, ttl int) string {
	return `{"id":"` + id + `","createdAt":1692862151,"updatedAt":1692862151,"domainId":"85371689655342080","groupId":"","groupName":"","host":"` + host +
		`","displayHost":"` + host + `","type":` + strconv.Itoa(typ) + `,"lineId":"` + lineID + `","lineCode":"","lineName":"","data":"` + data +
		`","displayData":"` + data + `","ttl":` + strconv.Itoa(ttl) + `,"weight":1,"preference":10,"domaint":false,"system":false,"disable":false}`
}

func records(page, total int, recs ...string) dnstest.Exchange {
	return call("GET", "/api/recordList", map[string]string{"pageIndex": strconv.Itoa(page), "pageSize": "100", "domainId": "85371689655342080"}, nil,
		`{"total":`+strconv.Itoa(total)+`,"results":[`+strings.Join(recs, ",")+`]}`)
}

var existing = []string{
	rec("10", "www", 1, "192.0.2.1", "", 600),
	rec("11", "www", 1, "192.0.2.2", "", 600),
	rec("12", "www", 1, "192.0.2.1", "84613316902921216", 600), // 电信 line
	rec("13", "@", 16, "keep", "", 600),
}

func TestGetRecordsPaginates(t *testing.T) {
	s := dnstest.Serve(t,
		domainLookup(),
		records(1, 3, rec("10", "www", 1, "192.0.2.1", "", 600), rec("11", "@", 15, "mail.example.com.", "", 600)),
		records(2, 3, rec("12", "_acme-challenge", 16, "token", "", 600)),
	)
	got, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || !dnstest.Has(got, "www", "A", "192.0.2.1") || !dnstest.Has(got, "@", "MX", "10 mail.example.com.") ||
		!dnstest.Has(got, "_acme-challenge", "TXT", "token") || got[0].RR().TTL != 600*time.Second {
		t.Fatalf("records: %+v", got)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		domainLookup(),
		call("POST", "/api/record", nil, map[string]any{"domainId": "85371689655342080", "type": 16, "host": "_acme-challenge.cdn", "data": "token", "ttl": 600},
			`{"id":"85369994254488576"}`),
		call("POST", "/api/record", nil, map[string]any{"domainId": "85371689655342080", "type": 15, "host": "@", "data": "mail.example.com", "ttl": 600, "preference": 10},
			`{"id":"85369994254488577"}`),
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge.cdn", "token", 600), libdns.RR{Name: "@", Type: "MX", Data: "10 mail.example.com", TTL: 600 * time.Second},
	})
	if err != nil || len(done) != 2 {
		t.Fatalf("done %v err %v", done, err)
	}
	if strings.Contains(string(s.Requests[1].Body), "lineId") {
		t.Fatalf("create names a line: %s", s.Requests[1].Body)
	}
}

func TestSetRecordsReplacesTheRRset(t *testing.T) {
	s := dnstest.Serve(t,
		domainLookup(),
		records(1, 4, existing...),
		// 192.0.2.1 on the default line stays with a new TTL, 192.0.2.2 and the
		// telecom-line copy go, 192.0.2.3 is created; the TXT is untouched.
		call("PUT", "/api/record", nil, map[string]any{"id": "10", "type": 1, "host": "www", "data": "192.0.2.1", "ttl": 60}, `null`),
		call("DELETE", "/api/record", map[string]string{"id": "11"}, nil, `null`),
		call("DELETE", "/api/record", map[string]string{"id": "12"}, nil, `null`),
		call("POST", "/api/record", nil, map[string]any{"domainId": "85371689655342080", "type": 1, "host": "www", "data": "192.0.2.3", "ttl": 60},
			`{"id":"85369994254488578"}`),
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
		domainLookup(),
		records(1, 4, existing...),
		call("DELETE", "/api/record", map[string]string{"id": "11"}, nil, `null`),
		call("DELETE", "/api/record", map[string]string{"id": "13"}, nil, `null`),
	)
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 0), libdns.RR{Name: "@", Type: "TXT"},
	})
	if err != nil || len(deleted) != 2 || !dnstest.Has(deleted, "@", "TXT", "keep") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	zone := func(id, name string) string {
		return `{"id":"` + id + `","createdAt":1692856597,"updatedAt":1692856597,"userId":"85068081529119744","userAccount":"foo@foo.com","assetId":"","groupId":"","groupName":"","domain":"` +
			name + `","displayDomain":"` + name + `","state":1,"nsState":0,"nsCheckedAt":0,"productCode":"","productName":"","expiredAt":4102416000,"quoteDomainId":"","quoteDomain":"","suffix":"com.","displaySuffix":"com."}`
	}
	s := dnstest.Serve(t,
		call("GET", "/api/domainList", map[string]string{"pageIndex": "1", "pageSize": "100", "groupId": ""}, nil, `{"total":2,"results":[`+zone("1", "example.com.")+`]}`),
		call("GET", "/api/domainList", map[string]string{"pageIndex": "2", "pageSize": "100"}, nil, `{"total":2,"results":[`+zone("2", "Example.NET.")+`]}`),
	)
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	unauthorized := domainLookup()
	unauthorized.Status, unauthorized.Response = 401, "Unauthorized"
	unauthorized.ResponseHeader = map[string]string{"Content-Type": "text/plain; charset=utf-8"}
	unknown := domainLookup()
	unknown.Response = `{"code":601,"msg":"域名不存在","data":null}`
	empty := domainLookup()
	empty.Response = `{"code":200,"msg":"","data":null}`
	internal := domainLookup()
	internal.Status, internal.Response = 502, "bad gateway"
	business := domainLookup()
	business.Response = `{"code":500,"msg":"internal error","data":null}`
	s := dnstest.Serve(t, unauthorized, unknown, empty, internal, business)
	p := provider(t, s)
	ctx := context.Background()
	_, err := p.GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, apiSecret, basic)
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("authentication failure: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown domain (6xx): %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown domain (no data): %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("business code 500: %v", err)
	}
	if _, err := p.AppendRecords(ctx, "example.com.", []libdns.Record{libdns.RR{Name: "x", Type: "HTTPS", Data: "1 . alpn=h2"}}); !errors.Is(err, dnsx.ErrUnsupported) {
		t.Fatalf("unsupported type: %v", err)
	}
	for _, fields := range []map[string]string{
		{"api_id": "", "api_secret": apiSecret},
		{"api_id": "my:id", "api_secret": apiSecret},
		{"api_id": apiID, "api_secret": ""},
		{"api_id": apiID, "api_secret": "has space"},
	} {
		if _, err := New(fields, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed credentials accepted: %v", err)
		}
	}
}
