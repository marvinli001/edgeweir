package westcn

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/libdns/libdns"
	"golang.org/x/text/encoding/simplifiedchinese"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Requests and responses follow the West.cn API v2 reference
// (https://www.west.cn/CustomerCenter/doc/apiv2.html: 1.2 token, 1.4 result
// envelope; https://www.west.cn/CustomerCenter/doc/domain_v2.html: 3.3
// getdomains, 3.7 adddnsrecord, 3.8 moddnsrecord, 3.9 deldnsrecord,
// 3.10 getdnsrecord, 6.1 error codes). Bodies are GBK.
const (
	username = "zhangsan"
	password = "5dh232kfg!*"
)

var clock = time.UnixMilli(1790000000123)

const stamp = "1790000000123"

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	p, err := New(map[string]string{"username": username, "api_password": password}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	pp := p.(*Provider)
	pp.now = func() time.Time { return clock }
	return pp
}

func gbk(s string) string {
	out, err := simplifiedchinese.GBK.NewEncoder().String(s)
	if err != nil {
		panic(err)
	}
	return out
}

func auth(fields map[string]string) map[string]string {
	out := map[string]string{"username": username, "time": stamp, "token": token(username, password, stamp)}
	for k, v := range fields {
		out[k] = v
	}
	return out
}

func post(act string, form map[string]string, response string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "POST", Path: "/domain/", Query: map[string]string{"act": act, "token": "", "username": ""},
		Header:   map[string]string{"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "edgeweir-certd/1 (DNS records)"},
		Form:     auth(form),
		Response: gbk(response), ResponseHeader: map[string]string{"Content-Type": "text/html; charset=gbk"},
	}
}

func item(id int, host, typ, value string, ttl int, line string) string {
	return fmt.Sprintf(`{"id":%d,"item":%q,"value":%q,"type":%q,"level":10,"ttl":%d,"line":%q,"pause":0}`, id, host, value, typ, ttl, line)
}

func listCall(page, total, pages int, items ...string) dnstest.Exchange {
	return post("getdnsrecord", map[string]string{"domain": "example.com", "limit": "1000", "pageno": fmt.Sprint(page)},
		fmt.Sprintf(`{"result":200,"clientid":"2019041511322685546","data":{"items":[%s],"limit":1000,"total":%d,"pageno":%d,"totalpages":%d}}`, strings.Join(items, ","), total, page, pages))
}

const ok = `{"result":200,"clientid":"2019041511322685546"}`

func TestTokenMatchesTheDocumentedExample(t *testing.T) {
	if got := token("zhangsan", "5dh232kfg!*", "1554691950854"); got != "f17581fb2535b2a7ee4468eb3f96a2a9" {
		t.Fatalf("token %s", got)
	}
}

func TestGetRecordsFollowsPages(t *testing.T) {
	// The server returns fewer items than asked for; totalpages decides.
	s := dnstest.Serve(t,
		listCall(1, 5, 2, item(1, "www", "A", "192.0.2.1", 900, ""), item(2, "www", "A", "192.0.2.2", 900, "LTEL"), item(3, "@", "TXT", "验证", 600, "")),
		listCall(2, 5, 2, item(4, "cdn", "CNAME", "edge.example.net", 60, ""), item(5, "@", "MX", "mx.example.net", 600, "")),
	)
	got, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 5 || !dnstest.Has(got, "@", "TXT", "验证") || !dnstest.Has(got, "www", "A", "192.0.2.2") || got[3].RR().TTL != time.Minute {
		t.Fatalf("records: %+v", got)
	}
}

func TestGetRecordsEmptyZone(t *testing.T) {
	s := dnstest.Serve(t, post("getdnsrecord", nil, `{"result":500,"clientid":"1","msg":"查询数据结果为空","errcode":30001}`))
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil || len(records) != 0 {
		t.Fatalf("records %v err %v", records, err)
	}
}

func TestAppendRecords(t *testing.T) {
	add := post("adddnsrecord", map[string]string{"domain": "example.com", "host": "_acme-challenge", "type": "TXT", "value": gbk("验证"), "ttl": "60", "level": "10"},
		`{"result":200,"clientid":"1","data":{"id":20}}`)
	add.Check = func(t *testing.T, r *http.Request, body []byte) {
		if !strings.Contains(string(body), "value=%D1%E9%D6%A4") {
			t.Errorf("value is not GBK: %s", body)
		}
	}
	s := dnstest.Serve(t, add,
		post("adddnsrecord", map[string]string{"host": "cdn", "type": "CNAME", "value": "edge.example.net", "ttl": "600"},
			`{"result":500,"clientid":"2","msg":"记录已经存在重复添加","errcode":20118}`),
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", "验证", 30), dnstest.CNAME("cdn", "edge.example.net.", 600),
	})
	if err != nil || len(done) != 2 || done[0].RR().TTL != time.Minute {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsReplacesTheRRsets(t *testing.T) {
	s := dnstest.Serve(t,
		listCall(1, 7, 1,
			item(1, "www", "A", "192.0.2.1", 900, ""),
			item(2, "www", "A", "192.0.2.2", 900, ""),
			item(3, "www", "A", "192.0.2.9", 900, "LTEL"),
			item(4, "@", "TXT", "keep", 900, ""),
			item(5, "cdn", "CNAME", "old.example.net", 900, ""),
			item(6, "api", "AAAA", "2001:db8::1", 600, ""),
			item(7, "api", "AAAA", "2001:db8::2", 600, ""),
		),
		// www: .1 stays with a new TTL, .2 is rewritten to .3, .4 is created, the telecom-line member goes.
		post("moddnsrecord", map[string]string{"domain": "example.com", "id": "1", "value": "192.0.2.1", "ttl": "60"}, ok),
		post("moddnsrecord", map[string]string{"domain": "example.com", "id": "2", "value": "192.0.2.3", "ttl": "60"}, ok),
		// cdn: the single CNAME is rewritten in place.
		post("moddnsrecord", map[string]string{"domain": "example.com", "id": "5", "value": "new.example.net", "ttl": "900"}, ok),
		post("adddnsrecord", map[string]string{"domain": "example.com", "host": "www", "type": "A", "value": "192.0.2.4", "ttl": "60"}, `{"result":200,"clientid":"1","data":{"id":8}}`),
		post("deldnsrecord", map[string]string{"domain": "example.com", "id": "3"}, ok),
		// api: ::1 is kept unchanged, ::2 is deleted; the TXT is untouched.
		post("deldnsrecord", map[string]string{"domain": "example.com", "id": "7"}, ok),
	)
	got, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60), dnstest.A("www", "192.0.2.4", 30),
		dnstest.CNAME("cdn", "new.example.net.", 900), dnstest.AAAA("api", "2001:db8::1", 600),
	})
	if err != nil || len(got) != 5 {
		t.Fatalf("got %v err %v", got, err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		listCall(1, 4, 1, item(1, "www", "A", "192.0.2.1", 900, ""), item(2, "www", "A", "192.0.2.2", 900, ""),
			item(3, "_acme-challenge", "TXT", "t1", 60, ""), item(4, "_acme-challenge", "TXT", "t1", 60, "LCNC")),
		// Other lines go first.
		post("deldnsrecord", map[string]string{"id": "4"}, ok),
		post("deldnsrecord", map[string]string{"id": "2"}, ok),
		post("deldnsrecord", map[string]string{"id": "3"}, `{"result":500,"clientid":"1","msg":"解析记录ID有误","errcode":20120}`),
	)
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 60), libdns.RR{Name: "_acme-challenge", Type: "TXT"}, dnstest.A("www", "192.0.2.99", 60),
	})
	if err != nil || len(deleted) != 3 {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{
		Method: "GET", Path: "/domain/", Query: auth(map[string]string{"act": "getdomains", "limit": "1000", "page": "1"}),
		Response: gbk(`{"result":200,"clientid":"1","data":{"items":[
			{"domain":"example.com","regdate":"2019-04-15","expdate":"2027-04-15","dns1":"ns1.myhostadmin.net","dns2":"ns2.myhostadmin.net","year":1,"clienthold":0,"registrars":"west"},
			{"domain":"Example.CN","regdate":"2020-01-01","expdate":"2027-01-01","dns1":"ns1.myhostadmin.net","dns2":"ns2.myhostadmin.net","year":1,"clienthold":0,"registrars":"west"}],
			"limit":1000,"total":2,"pageno":1,"totalpages":1}}`),
		Check: func(t *testing.T, r *http.Request, body []byte) {
			if len(body) != 0 {
				t.Errorf("GET with a body: %s", body)
			}
		},
	})
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.cn." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		post("getdnsrecord", nil, `{"result":500,"clientid":"1","msg":"认证失败 `+password+`","errcode":10000}`),
		post("getdnsrecord", nil, `{"result":500,"clientid":"2","msg":"ip 授权失败","errcode":10002}`),
		post("getdnsrecord", nil, `{"result":500,"clientid":"3","msg":"无权操作或数据不存在","errcode":20001}`),
		dnstest.Exchange{Method: "POST", Path: "/domain/", Status: 502, Response: `bad gateway`},
	)
	p := provider(t, s)
	ctx := context.Background()
	for i := range 2 {
		_, err := p.GetRecords(ctx, "example.com.")
		dnstest.NoSecret(t, err, password, token(username, password, stamp))
		if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
			t.Fatalf("auth failure %d: %v", i, err)
		}
		if i == 1 && !strings.Contains(err.Error(), "IP address") {
			t.Fatalf("IP authorization: %v", err)
		}
	}
	if _, err := p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err := p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	for _, fields := range []map[string]string{
		{"username": "", "api_password": password},
		{"username": "zhang san", "api_password": password},
		{"username": username, "api_password": ""},
		{"username": username, "api_password": "a\r\nb"},
	} {
		if _, err := New(fields, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed credentials accepted: %v", err)
		}
	}
	// A value outside GBK cannot be sent.
	if _, err := provider(t, dnstest.Serve(t)).AppendRecords(ctx, "example.com.", []libdns.Record{dnstest.TXT("x", "\U0001F600", 60)}); !errors.Is(err, dnsx.ErrInvalid) {
		t.Fatalf("non-GBK value: %v", err)
	}
}
