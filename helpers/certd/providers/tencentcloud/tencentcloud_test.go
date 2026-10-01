package tencentcloud

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Responses follow the examples of the DNSPod API 3.0 reference:
// DescribeRecordList https://cloud.tencent.com/document/api/1427/56166,
// CreateRecord https://cloud.tencent.com/document/api/1427/56180,
// ModifyRecord https://cloud.tencent.com/document/api/1427/56157,
// DeleteRecord https://cloud.tencent.com/document/api/1427/56176,
// DescribeDomainList https://cloud.tencent.com/document/api/1427/56172,
// error codes https://cloud.tencent.com/document/api/1427/56192. The
// signature vector is the example of https://cloud.tencent.com/document/api/1427/56189.
const (
	secretID  = "TENCENTCLOUDTESTSECRETID00000000"
	secretKey = "Gu5t9xGARNpq86cd98joQYCN3EXAMPLE"
)

var clock = time.Unix(1790000000, 0)

func provider(t *testing.T, s *dnstest.Server, site string) *Provider {
	t.Helper()
	p, err := New(map[string]string{"secret_id": secretID, "secret_key": secretKey, "site": site}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	pp := p.(*Provider)
	pp.now = func() time.Time { return clock }
	return pp
}

func signed(action string) func(t *testing.T, r *http.Request, body []byte) {
	return func(t *testing.T, r *http.Request, body []byte) {
		t.Helper()
		for k, v := range map[string]string{
			"X-TC-Action": action, "X-TC-Version": "2021-03-23", "X-TC-Timestamp": "1790000000",
			"Content-Type": "application/json; charset=utf-8", "User-Agent": "edgeweir-certd/1 (DNS records)",
		} {
			if got := r.Header.Get(k); got != v {
				t.Errorf("header %s = %q, want %q", k, got, v)
			}
		}
		if got, want := r.Header.Get("Authorization"), authorization(secretID, secretKey, "dnspod", r.Host, action, 1790000000, body); got != want {
			t.Errorf("Authorization = %q, want %q", got, want)
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "TC3-HMAC-SHA256 Credential="+secretID+"/2026-09-21/dnspod/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=") {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
	}
}

func call(action string, body map[string]any, response string) dnstest.Exchange {
	e := dnstest.Exchange{Method: "POST", Path: "/", Check: signed(action), Response: `{"Response":` + response + `}`}
	if body != nil {
		e.JSON = body
	}
	return e
}

func rec(id int, name, typ, value string, ttl int, line, lineID string) string {
	return fmt.Sprintf(`{"RecordId":%d,"Value":%q,"Status":"ENABLE","UpdatedOn":"2021-03-28 11:27:09","Name":%q,"Line":%q,"LineId":%q,"Type":%q,"Weight":null,"MonitorStatus":"","Remark":"","TTL":%d,"MX":0,"DefaultNS":false}`,
		id, value, name, line, lineID, typ, ttl)
}

const ns = `{"RecordId":556507778,"Value":"f1g1ns1.dnspod.net.","Status":"ENABLE","UpdatedOn":"2021-03-28 11:27:09","Name":"@","Line":"默认","LineId":"0","Type":"NS","Weight":null,"MonitorStatus":"","Remark":"","TTL":86400,"MX":0,"DefaultNS":true}`

func listCall(offset, total int, records ...string) dnstest.Exchange {
	return call("DescribeRecordList", map[string]any{"Domain": "example.com", "Offset": offset, "Limit": 3000},
		fmt.Sprintf(`{"RequestId":"561cdfcb-37a6-47de-b3c5-2b038e2c2276","RecordCountInfo":{"SubdomainCount":2,"TotalCount":%d,"ListCount":%d},"RecordList":[%s]}`, total, len(records), strings.Join(records, ",")))
}

func TestAuthorizationMatchesTheDocumentedVector(t *testing.T) {
	// The documented payload carries JSON escapes, not the characters.
	payload := `{"Limit": 1, "Filters": [{"Values": ["` + `\` + "u672a" + `\` + "u547d" + `\` + "u540d" + `"], "Name": "instance-name"}]}`
	got := authorization("AKID********************************", "********************************", "cvm", "cvm.tencentcloudapi.com", "DescribeInstances", 1551113065, []byte(payload))
	want := "TC3-HMAC-SHA256 Credential=AKID********************************/2019-02-25/cvm/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f"
	if got != want {
		t.Fatalf("authorization\n got %s\nwant %s", got, want)
	}
}

func TestGetRecordsFollowsPages(t *testing.T) {
	first := []string{ns}
	for i := range 2999 {
		first = append(first, rec(1000+i, fmt.Sprintf("h%d", i), "A", "192.0.2.1", 600, "默认", "0"))
	}
	s := dnstest.Serve(t,
		listCall(0, 3002, first...),
		listCall(3000, 3002, rec(9, "_acme-challenge", "TXT", "t1", 600, "默认", "0"), rec(10, "WWW", "CNAME", "edge.example.net.", 60, "电信", "10=0")),
	)
	got, err := provider(t, s, "").GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3002 || !dnstest.Has(got, "@", "NS", "f1g1ns1.dnspod.net.") || !dnstest.Has(got, "www", "CNAME", "edge.example.net") ||
		!dnstest.Has(got, "_acme-challenge", "TXT", "t1") || got[3000].RR().TTL != 600*time.Second {
		t.Fatalf("records: %d", len(got))
	}
}

func TestGetRecordsEmptyZone(t *testing.T) {
	s := dnstest.Serve(t, call("DescribeRecordList", nil, `{"Error":{"Code":"ResourceNotFound.NoDataOfRecord","Message":"记录列表为空。"},"RequestId":"1"}`))
	records, err := provider(t, s, "").GetRecords(context.Background(), "example.com.")
	if err != nil || len(records) != 0 {
		t.Fatalf("records %v err %v", records, err)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		call("CreateRecord", map[string]any{"Domain": "example.com", "SubDomain": "_acme-challenge", "RecordType": "TXT", "RecordLine": "默认", "RecordLineId": "0", "Value": "token-value", "TTL": 60},
			`{"Error":{"Code":"LimitExceeded.RecordTtlLimit","Message":"记录的TTL值超出了限制。"},"RequestId":"a"}`),
		call("CreateRecord", map[string]any{"SubDomain": "_acme-challenge", "Value": "token-value", "TTL": 600}, `{"RequestId":"b","RecordId":162}`),
		call("CreateRecord", map[string]any{"SubDomain": "@", "RecordType": "A", "Value": "192.0.2.7", "TTL": 600},
			`{"Error":{"Code":"InvalidParameter.DomainRecordExist","Message":"记录已经存在，无需再次添加。"},"RequestId":"c"}`),
	)
	done, err := provider(t, s, "cn").AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", "token-value", 60), dnstest.A("@", "192.0.2.7", 600),
	})
	if err != nil || len(done) != 2 || done[0].RR().TTL != 600*time.Second {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestInternationalSite(t *testing.T) {
	s := dnstest.Serve(t, call("CreateRecord", map[string]any{"Domain": "example.com", "SubDomain": "www", "RecordLine": "Default", "RecordLineId": "0"}, `{"RequestId":"a","RecordId":7}`))
	if _, err := provider(t, s, "intl").AppendRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.1", 600)}); err != nil {
		t.Fatal(err)
	}
	for site, host := range map[string]string{"": "https://dnspod.tencentcloudapi.com", "cn": "https://dnspod.tencentcloudapi.com", "intl": "https://dnspod.intl.tencentcloudapi.com"} {
		p, err := New(map[string]string{"secret_id": secretID, "secret_key": secretKey, "site": site}, dnsx.Options{})
		if err != nil || p.(*Provider).BaseURL != host {
			t.Fatalf("site %q: %v", site, err)
		}
	}
}

func TestSetRecordsReplacesTheRRsets(t *testing.T) {
	s := dnstest.Serve(t,
		listCall(0, 8, ns,
			rec(1, "www", "A", "192.0.2.1", 600, "默认", "0"),
			rec(2, "www", "A", "192.0.2.2", 600, "默认", "0"),
			rec(3, "www", "A", "192.0.2.9", 600, "电信", "10=0"),
			rec(4, "@", "TXT", "keep", 600, "默认", "0"),
			rec(5, "cdn", "CNAME", "old.example.net.", 600, "默认", "0"),
			rec(6, "api", "AAAA", "2001:db8::1", 600, "默认", "0"),
			rec(7, "api", "AAAA", "2001:db8::2", 600, "默认", "0"),
		),
		// www: .1 stays with a new TTL, .2 is rewritten to .3, .4 is created, the carrier-line member goes.
		call("ModifyRecord", map[string]any{"Domain": "example.com", "RecordId": 1, "SubDomain": "www", "RecordType": "A", "RecordLine": "默认", "RecordLineId": "0", "Value": "192.0.2.1", "TTL": 300}, `{"RequestId":"a","RecordId":1}`),
		call("ModifyRecord", map[string]any{"RecordId": 2, "SubDomain": "www", "Value": "192.0.2.3", "TTL": 300}, `{"RequestId":"b","RecordId":2}`),
		// cdn: the single CNAME is rewritten in place.
		call("ModifyRecord", map[string]any{"RecordId": 5, "SubDomain": "cdn", "RecordType": "CNAME", "Value": "new.example.net.", "TTL": 600}, `{"RequestId":"c","RecordId":5}`),
		call("CreateRecord", map[string]any{"SubDomain": "www", "RecordType": "A", "Value": "192.0.2.4", "TTL": 300}, `{"RequestId":"d","RecordId":8}`),
		call("DeleteRecord", map[string]any{"Domain": "example.com", "RecordId": 3}, `{"RequestId":"e"}`),
		// api: ::1 is kept unchanged, ::2 is deleted; the TXT is untouched.
		call("DeleteRecord", map[string]any{"Domain": "example.com", "RecordId": 7}, `{"RequestId":"f"}`),
	)
	got, err := provider(t, s, "").SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 300), dnstest.A("www", "192.0.2.3", 300), dnstest.A("www", "192.0.2.4", 300),
		dnstest.CNAME("cdn", "new.example.net.", 600), dnstest.AAAA("api", "2001:db8::1", 600),
	})
	if err != nil || len(got) != 5 || got[4].RR().TTL != 600*time.Second {
		t.Fatalf("got %v err %v", got, err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		listCall(0, 4, ns, rec(1, "www", "A", "192.0.2.1", 600, "默认", "0"), rec(2, "www", "A", "192.0.2.2", 600, "默认", "0"), rec(5, "_acme-challenge", "TXT", "t1", 600, "默认", "0")),
		call("DeleteRecord", map[string]any{"Domain": "example.com", "RecordId": 2}, `{"RequestId":"a"}`),
		call("DeleteRecord", map[string]any{"Domain": "example.com", "RecordId": 5}, `{"Error":{"Code":"InvalidParameter.RecordIdInvalid","Message":"记录编号错误。"},"RequestId":"b"}`),
	)
	deleted, err := provider(t, s, "").DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 60), libdns.RR{Name: "_acme-challenge", Type: "TXT"}, dnstest.A("www", "192.0.2.99", 60),
	})
	if err != nil || len(deleted) != 2 {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t, call("DescribeDomainList", map[string]any{"Type": "ALL", "Offset": 0, "Limit": 3000},
		`{"DomainCountInfo":{"DomainTotal":2,"AllTotal":2,"MineTotal":2,"ShareTotal":0,"VipTotal":0,"PauseTotal":0,"ErrorTotal":0,"LockTotal":0,"SpamTotal":0,"VipExpire":0,"ShareOutTotal":0,"GroupTotal":2},
		"DomainList":[{"DomainId":62,"Name":"example.com","Status":"ENABLE","TTL":600,"CNAMESpeedup":"DISABLE","DNSStatus":"","Grade":"DP_FREE","GroupId":1,"Punycode":"example.com","EffectiveDNS":["f1g1ns1.dnspod.net","f1g1ns2.dnspod.net"],"RecordCount":3},
		{"DomainId":63,"Name":"例子.中国","Status":"ENABLE","TTL":600,"Grade":"DP_FREE","Punycode":"xn--fsqu00a.xn--fiqs8s","RecordCount":2}],"RequestId":"1"}`))
	zones, err := provider(t, s, "").ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "xn--fsqu00a.xn--fiqs8s." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	failure := func(code, message string) dnstest.Exchange {
		return dnstest.Exchange{Method: "POST", Path: "/", Response: fmt.Sprintf(`{"Response":{"Error":{"Code":%q,"Message":%q},"RequestId":"ed93f3cb-f35e-473f-b9f3-0d451b8b79c6"}}`, code, message)}
	}
	s := dnstest.Serve(t,
		failure("AuthFailure.SignatureFailure", "The provided credentials could not be validated. Please check your signature is correct."),
		failure("AuthFailure.SecretIdNotFound", "The SecretId "+secretID+" is not found."),
		failure("FailedOperation.NotDomainOwner", "The domain is not under your account."),
		failure("RequestLimitExceeded", "Your current request times equals to `21` in a second."),
		dnstest.Exchange{Method: "POST", Path: "/", Status: 502, Response: `bad gateway`},
	)
	p := provider(t, s, "")
	ctx := context.Background()
	for i := range 2 {
		_, err := p.GetRecords(ctx, "example.com.")
		dnstest.NoSecret(t, err, secretKey, secretID)
		if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
			t.Fatalf("auth failure %d: %v", i, err)
		}
	}
	if _, err := p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err := p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_rate_limited" {
		t.Fatalf("throttled: %v", err)
	}
	if _, err := p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	for _, fields := range []map[string]string{
		{"secret_id": "", "secret_key": secretKey},
		{"secret_id": "AKID\nX", "secret_key": secretKey},
		{"secret_id": secretID, "secret_key": "has space"},
		{"secret_id": secretID, "secret_key": secretKey, "site": "dnspod.example.net"},
	} {
		if _, err := New(fields, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed credentials accepted: %v", err)
		}
	}
}
