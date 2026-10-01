package alidns

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

// Responses follow the examples of the Alidns 2015-01-09 API reference
// (https://help.aliyun.com/zh/dns/api-alidns-2015-01-09-describedomainrecords,
// -adddomainrecord, -updatedomainrecord, -deletedomainrecord, -describedomains)
// and its error center; the signature vector is the fixed-value example of
// https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature.
const (
	keyID  = "LTAI5tExampleKeyId0001"
	secret = "exampleSecret0123456789abcdef0"
	sts    = "CAIS-example-security-token"
	nonce  = "3156853299f313e23d1673dc12e1703d"
)

var clock = time.Date(2026, 9, 30, 10, 22, 32, 0, time.UTC)

func provider(t *testing.T, s *dnstest.Server, fields map[string]string) *Provider {
	t.Helper()
	if fields == nil {
		fields = map[string]string{"access_key_id": keyID, "access_key_secret": secret}
	}
	p, err := New(fields, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	pp := p.(*Provider)
	pp.now = func() time.Time { return clock }
	pp.nonce = func() string { return nonce }
	return pp
}

// signed asserts the ACS3 headers of a request and recomputes its signature.
func signed(action string, token string) func(t *testing.T, r *http.Request, body []byte) {
	return func(t *testing.T, r *http.Request, body []byte) {
		t.Helper()
		want := map[string]string{
			"x-acs-action": action, "x-acs-version": "2015-01-09", "x-acs-date": "2026-09-30T10:22:32Z",
			"x-acs-signature-nonce": nonce, "x-acs-content-sha256": sha256Hex(nil),
		}
		if token != "" {
			want["x-acs-security-token"] = token
		}
		for k, v := range want {
			if got := r.Header.Get(k); got != v {
				t.Errorf("header %s = %q, want %q", k, got, v)
			}
		}
		if len(body) != 0 {
			t.Errorf("body %q, want empty (parameters travel in the query)", body)
		}
		headers := map[string]string{"host": r.Host}
		for k, v := range want {
			headers[k] = v
		}
		if got, exp := r.Header.Get("Authorization"), authorization(keyID, secret, "POST", r.URL.RawQuery, headers, sha256Hex(nil)); got != exp {
			t.Errorf("Authorization = %q, want %q", got, exp)
		}
		signedHeaders := "host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version"
		if token != "" {
			signedHeaders = "host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-security-token;x-acs-signature-nonce;x-acs-version"
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "ACS3-HMAC-SHA256 Credential="+keyID+",SignedHeaders="+signedHeaders+",Signature=") {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
	}
}

func call(action string, query map[string]string, response string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "POST", Path: "/", Query: query,
		Header:   map[string]string{"x-acs-action": action, "User-Agent": "edgeweir-certd/1 (DNS records)"},
		Check:    signed(action, ""),
		Response: response,
	}
}

func records(total int, list ...string) string {
	return fmt.Sprintf(`{"TotalCount":%d,"PageSize":500,"RequestId":"536E9CAD-DB30-4647-AC87-AA5CC38C5382","DomainRecords":{"Record":[%s]},"PageNumber":1}`, total, strings.Join(list, ","))
}

func rec(id, rr, typ, value string, ttl int, line string) string {
	return fmt.Sprintf(`{"Status":"Enable","Type":%q,"TTL":%d,"RecordId":%q,"RR":%q,"DomainName":"example.com","Weight":1,"Value":%q,"Line":%q,"Locked":false}`, typ, ttl, id, rr, value, line)
}

// listCall is a page of the unfiltered list (no Line parameter).
func listCall(page, response string) dnstest.Exchange {
	return call("DescribeDomainRecords", map[string]string{"DomainName": "example.com", "PageNumber": page, "PageSize": "500", "Line": ""}, response)
}

// lineLists are the reads per non-default line that follow the unfiltered
// pages (the documented Line filter defaults to "default"); lines missing
// from byLine answer an empty list.
func lineLists(byLine map[string]string) []dnstest.Exchange {
	var out []dnstest.Exchange
	for _, line := range []string{"telecom", "unicom", "mobile", "edu", "oversea"} {
		response := byLine[line]
		if response == "" {
			response = records(0)
		}
		out = append(out, call("DescribeDomainRecords", map[string]string{"DomainName": "example.com", "PageNumber": "1", "PageSize": "500", "Line": line}, response))
	}
	return out
}

// seq flattens exchanges and exchange lists into one cassette.
func seq(parts ...any) []dnstest.Exchange {
	var out []dnstest.Exchange
	for _, part := range parts {
		switch v := part.(type) {
		case dnstest.Exchange:
			out = append(out, v)
		case []dnstest.Exchange:
			out = append(out, v...)
		}
	}
	return out
}

func TestAuthorizationMatchesTheDocumentedVector(t *testing.T) {
	got := authorization("YourAccessKeyId", "YourAccessKeySecret", "POST",
		"ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai",
		map[string]string{
			"host": "ecs.cn-shanghai.aliyuncs.com", "x-acs-action": "RunInstances", "x-acs-version": "2014-05-26",
			"x-acs-date": "2023-10-26T10:22:32Z", "x-acs-signature-nonce": "3156853299f313e23d1673dc12e1703d",
			"x-acs-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		}, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
	want := "ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0"
	if got != want {
		t.Fatalf("authorization\n got %s\nwant %s", got, want)
	}
	if q := canonicalQuery(map[string]string{"Value": "v=a b*c~d/e", "RR": "_acme-challenge"}); q != "RR=_acme-challenge&Value=v%3Da%20b%2Ac~d%2Fe" {
		t.Fatalf("canonical query %s", q)
	}
}

func TestGetRecordsFollowsPages(t *testing.T) {
	first := make([]string, 0, 500)
	for i := range 500 {
		first = append(first, rec(fmt.Sprint(1000+i), fmt.Sprintf("h%d", i), "A", "192.0.2.1", 600, "default"))
	}
	s := dnstest.Serve(t, seq(
		listCall("1", records(502, first...)),
		listCall("2", records(502, rec("9", "@", "TXT", `"quoted text"`, 600, "default"), rec("10", "WWW", "CNAME", "edge.example.net", 60, "telecom"))),
		// The telecom read returns record 10 again: it is listed once.
		lineLists(map[string]string{"telecom": records(1, rec("10", "WWW", "CNAME", "edge.example.net", 60, "telecom"))}),
	)...)
	got, err := provider(t, s, nil).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 502 || !dnstest.Has(got, "h499", "A", "192.0.2.1") || !dnstest.Has(got, "www", "CNAME", "edge.example.net") {
		t.Fatalf("records: %d", len(got))
	}
	if dnsx.LineOf(got[501]) != "telecom" || dnsx.LineOf(got[0]) != "" {
		t.Fatalf("lines: %q %q", dnsx.LineOf(got[501]), dnsx.LineOf(got[0]))
	}
	if txt := got[500].RR(); txt.Name != "@" || txt.Data != "quoted text" || txt.TTL != 600*time.Second {
		t.Fatalf("txt: %+v", txt)
	}
}

func TestAppendRecordsWithSecurityToken(t *testing.T) {
	add := call("AddDomainRecord", map[string]string{"DomainName": "example.com", "RR": "_acme-challenge", "Type": "TXT", "Value": "token-value", "TTL": "60", "Line": "default"},
		`{"RequestId":"536E9CAD-DB30-4647-AC87-AA5CC38C5382","RecordId":"999"}`)
	add.Check = signed("AddDomainRecord", sts)
	s := dnstest.Serve(t, add)
	p := provider(t, s, map[string]string{"access_key_id": keyID, "access_key_secret": secret, "security_token": sts, "region_id": "ap-southeast-1"})
	done, err := p.AppendRecords(context.Background(), "example.com.", []libdns.Record{dnstest.TXT("_acme-challenge", "token-value", 60)})
	if err != nil || len(done) != 1 || done[0].RR().TTL != time.Minute {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestAppendRecordsRetriesWithTheEditionMinimumTTL(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "POST", Path: "/", Query: map[string]string{"TTL": "60", "Value": "192.0.2.7"}, Status: 400,
			Response: `{"RequestId":"1","HostId":"alidns.aliyuncs.com","Code":"QuotaExceeded.TTL","Message":"The TTL value is less than the minimum value allowed."}`},
		call("AddDomainRecord", map[string]string{"TTL": "600", "Value": "192.0.2.7", "RR": "cdn"}, `{"RequestId":"2","RecordId":"1000"}`),
		// An identical record already exists: nothing to add.
		dnstest.Exchange{Method: "POST", Path: "/", Query: map[string]string{"TTL": "600", "Value": "192.0.2.8"}, Status: 400,
			Response: `{"RequestId":"3","Code":"DomainRecordDuplicate","Message":"The DNS record already exists."}`},
	)
	done, err := provider(t, s, nil).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("cdn", "192.0.2.7", 60), dnstest.A("cdn", "192.0.2.8", 600),
	})
	if err != nil || len(done) != 2 || done[0].RR().TTL != 600*time.Second {
		t.Fatalf("done %v err %v", done, err)
	}
}

const zone = `{"Status":"Enable","Type":"TXT","TTL":600,"RecordId":"4","RR":"@","DomainName":"example.com","Value":"keep","Line":"default","Locked":false}`

func TestSetRecordsReplacesTheRRsets(t *testing.T) {
	s := dnstest.Serve(t, seq(
		listCall("1", records(6,
			rec("1", "www", "A", "192.0.2.1", 600, "default"),
			rec("2", "www", "A", "192.0.2.2", 600, "default"),
			zone,
			rec("5", "cdn", "CNAME", "old.example.net", 300, "default"),
			rec("6", "api", "AAAA", "2001:db8::1", 600, "default"),
			rec("7", "api", "AAAA", "2001:db8::2", 600, "default"),
		)),
		lineLists(map[string]string{"telecom": records(1, rec("3", "www", "A", "192.0.2.9", 600, "telecom"))}),
		// www: .1 stays with a new TTL, .2 is rewritten to .3, .4 is created, the telecom-line member goes.
		call("UpdateDomainRecord", map[string]string{"RecordId": "1", "RR": "www", "Type": "A", "Value": "192.0.2.1", "TTL": "60", "Line": "default"}, `{"RequestId":"a","RecordId":"1"}`),
		call("UpdateDomainRecord", map[string]string{"RecordId": "2", "RR": "www", "Type": "A", "Value": "192.0.2.3", "TTL": "60", "Line": "default"}, `{"RequestId":"b","RecordId":"2"}`),
		// cdn: the single CNAME is rewritten in place.
		call("UpdateDomainRecord", map[string]string{"RecordId": "5", "RR": "cdn", "Type": "CNAME", "Value": "new.example.net", "TTL": "300", "Line": "default"}, `{"RequestId":"c","RecordId":"5"}`),
		call("AddDomainRecord", map[string]string{"DomainName": "example.com", "RR": "www", "Type": "A", "Value": "192.0.2.4", "TTL": "60", "Line": "default"}, `{"RequestId":"d","RecordId":"8"}`),
		call("DeleteDomainRecord", map[string]string{"RecordId": "3"}, `{"RequestId":"e","RecordId":"3"}`),
		// api: ::1 is kept unchanged, ::2 is deleted.
		call("DeleteDomainRecord", map[string]string{"RecordId": "7"}, `{"RequestId":"f","RecordId":"7"}`),
	)...)
	got, err := provider(t, s, nil).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60), dnstest.A("www", "192.0.2.4", 60),
		dnstest.CNAME("cdn", "new.example.net.", 300), dnstest.AAAA("api", "2001:db8::1", 600),
	})
	if err != nil || len(got) != 5 {
		t.Fatalf("got %v err %v", got, err)
	}
}

func TestDeleteRecords(t *testing.T) {
	existing := records(4, rec("1", "www", "A", "192.0.2.1", 600, "default"), rec("2", "www", "A", "192.0.2.2", 600, "default"), zone, rec("5", "_acme-challenge", "TXT", "t1", 60, "default"))
	s := dnstest.Serve(t, seq(
		listCall("1", existing),
		lineLists(nil),
		call("DeleteDomainRecord", map[string]string{"RecordId": "2"}, `{"RequestId":"a","RecordId":"2"}`),
		call("DeleteDomainRecord", map[string]string{"RecordId": "5"}, `{"RequestId":"b","RecordId":"5"}`),
	)...)
	deleted, err := provider(t, s, nil).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 60), libdns.RR{Name: "_acme-challenge", Type: "TXT"}, dnstest.A("www", "192.0.2.99", 60),
	})
	if err != nil || len(deleted) != 2 || !dnstest.Has(deleted, "_acme-challenge", "TXT", "t1") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t, call("DescribeDomains", map[string]string{"PageNumber": "1", "PageSize": "100"},
		`{"TotalCount":2,"PageSize":100,"RequestId":"1","PageNumber":1,"Domains":{"Domain":[
		{"DomainName":"example.com\n","PunyCode":"example.com\n","VersionCode":"mianfei","AliDomain":true},
		{"DomainName":"例子.中国","PunyCode":"XN--FSQU00A.XN--FIQS8S","VersionCode":"version_enterprise_basic"}]}}`))
	zones, err := provider(t, s, nil).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "xn--fsqu00a.xn--fiqs8s." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	failure := func(status int, code, message string) dnstest.Exchange {
		return dnstest.Exchange{Method: "POST", Path: "/", Status: status,
			Response: fmt.Sprintf(`{"RequestId":"1","HostId":"alidns.aliyuncs.com","Code":%q,"Message":%q,"Recommend":"https://api.aliyun.com/troubleshoot"}`, code, message)}
	}
	s := dnstest.Serve(t,
		failure(404, "InvalidAccessKeyId.NotFound", "Specified access key is not found."),
		failure(400, "SignatureDoesNotMatch", "Specified signature is not matched with our calculation. key "+secret),
		failure(403, "Forbidden.RAM", "User not authorized to operate on the specified resource."),
		failure(400, "InvalidDomainName.NoExist", "The specified domain name does not exist."),
		failure(400, "Throttling.User", "Request was denied due to user flow control."),
		dnstest.Exchange{Method: "POST", Path: "/", Status: 503, Response: `<html>service unavailable</html>`},
	)
	p := provider(t, s, nil)
	ctx := context.Background()
	for i, want := range []error{dnsx.ErrAuth, dnsx.ErrAuth, dnsx.ErrAuth} {
		_, err := p.GetRecords(ctx, "example.com.")
		dnstest.NoSecret(t, err, secret)
		if !errors.Is(err, want) || dnsx.Code(err) != "dns_auth_failed" {
			t.Fatalf("auth failure %d: %v", i, err)
		}
	}
	if _, err := p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err := p.AppendRecords(ctx, "example.com.", []libdns.Record{dnstest.A("a", "192.0.2.1", 60)}); dnsx.Code(err) != "dns_rate_limited" {
		t.Fatalf("throttled: %v", err)
	}
	if _, err := p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	for _, fields := range []map[string]string{
		{"access_key_id": "", "access_key_secret": secret},
		{"access_key_id": "LTAI key", "access_key_secret": secret},
		{"access_key_id": keyID, "access_key_secret": "line\nbreak"},
		{"access_key_id": keyID, "access_key_secret": secret, "security_token": "a b"},
		{"access_key_id": keyID, "access_key_secret": secret, "region_id": "cn-hangzhou@127.0.0.1/#"},
		{"access_key_id": keyID, "access_key_secret": secret, "region_id": "../metadata"},
	} {
		if _, err := New(fields, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed credentials accepted: %v", err)
		}
	}
}

func TestRegionDoesNotChangeTheEndpoint(t *testing.T) {
	for _, region := range []string{"", "cn-hangzhou", "ap-southeast-1", "eu-central-1"} {
		p, err := New(map[string]string{"access_key_id": keyID, "access_key_secret": secret, "region_id": region}, dnsx.Options{})
		if err != nil || p.(*Provider).BaseURL != "https://alidns.aliyuncs.com" {
			t.Fatalf("region %q: %v", region, err)
		}
	}
}

func TestLineMapping(t *testing.T) {
	for canonical, code := range map[string]string{"": "default", "default": "default", "telecom": "telecom", "unicom": "unicom", "mobile": "mobile", "edu": "edu", "overseas": "oversea"} {
		if got, err := Lines.Provider(canonical); err != nil || got != code {
			t.Errorf("%q -> %q %v, want %q", canonical, got, err, code)
		}
		if got := Lines.Canonical(code); got != dnsx.NormalizeLine(canonical) {
			t.Errorf("%q -> %q, want %q", code, got, canonical)
		}
	}
	if got := Lines.Canonical("cn_telecom_beijing"); got != "other:cn_telecom_beijing" {
		t.Errorf("province line: %q", got)
	}
	if _, err := Lines.Provider("satellite"); !errors.Is(err, dnsx.ErrUnsupported) {
		t.Errorf("unknown line: %v", err)
	}
	if strings.Join(Lines.Lines(), ",") != strings.Join(dnsx.Lines, ",") {
		t.Errorf("lines %v", Lines.Lines())
	}
}

func TestAppendRecordsOnTwoLines(t *testing.T) {
	s := dnstest.Serve(t,
		call("AddDomainRecord", map[string]string{"DomainName": "example.com", "RR": "all", "Type": "A", "Value": "192.0.2.1", "TTL": "600", "Line": "default"}, `{"RequestId":"a","RecordId":"1"}`),
		call("AddDomainRecord", map[string]string{"DomainName": "example.com", "RR": "all", "Type": "A", "Value": "192.0.2.2", "TTL": "600", "Line": "telecom"}, `{"RequestId":"b","RecordId":"2"}`),
	)
	done, err := provider(t, s, nil).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("all", "192.0.2.1", 600), dnsx.OnLine(dnstest.A("all", "192.0.2.2", 600).RR(), "telecom"),
	})
	if err != nil || len(done) != 2 || dnsx.LineOf(done[0]) != "" || dnsx.LineOf(done[1]) != "telecom" {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestGetRecordsReturnsLines(t *testing.T) {
	s := dnstest.Serve(t, seq(
		listCall("1", records(2, rec("1", "all", "A", "192.0.2.1", 600, "default"), rec("2", "all", "A", "192.0.2.3", 600, "cn_telecom_beijing"))),
		lineLists(map[string]string{
			"telecom": records(1, rec("3", "all", "A", "192.0.2.2", 600, "telecom")),
			"oversea": records(1, rec("4", "all", "A", "198.51.100.1", 600, "oversea")),
		}),
	)...)
	got, err := provider(t, s, nil).GetRecords(context.Background(), "example.com.")
	if err != nil || len(got) != 4 {
		t.Fatalf("records %v err %v", got, err)
	}
	lines := map[string]string{}
	for _, r := range got {
		lines[r.RR().Data] = dnsx.LineOf(r)
	}
	want := map[string]string{"192.0.2.1": "", "192.0.2.2": "telecom", "192.0.2.3": "other:cn_telecom_beijing", "198.51.100.1": "overseas"}
	if fmt.Sprint(lines) != fmt.Sprint(want) {
		t.Fatalf("lines %v, want %v", lines, want)
	}
}

func TestSetRecordsAcrossLines(t *testing.T) {
	s := dnstest.Serve(t, seq(
		listCall("1", records(1, rec("1", "all", "A", "192.0.2.1", 600, "default"))),
		lineLists(map[string]string{
			"telecom": records(1, rec("2", "all", "A", "192.0.2.2", 600, "telecom")),
			"unicom":  records(1, rec("3", "all", "A", "192.0.2.3", 600, "unicom")),
		}),
		// default: kept; telecom: rewritten in place on its line; edu: created; the stale unicom copy goes.
		call("UpdateDomainRecord", map[string]string{"RecordId": "2", "RR": "all", "Type": "A", "Value": "192.0.2.5", "TTL": "600", "Line": "telecom"}, `{"RequestId":"a","RecordId":"2"}`),
		call("AddDomainRecord", map[string]string{"DomainName": "example.com", "RR": "all", "Type": "A", "Value": "192.0.2.6", "TTL": "600", "Line": "edu"}, `{"RequestId":"b","RecordId":"5"}`),
		call("DeleteDomainRecord", map[string]string{"RecordId": "3"}, `{"RequestId":"c","RecordId":"3"}`),
	)...)
	got, err := provider(t, s, nil).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("all", "192.0.2.1", 600),
		dnsx.OnLine(dnstest.A("all", "192.0.2.5", 600).RR(), "telecom"),
		dnsx.OnLine(dnstest.A("all", "192.0.2.6", 600).RR(), "edu"),
	})
	if err != nil || len(got) != 3 || dnsx.LineOf(got[1]) != "telecom" || dnsx.LineOf(got[2]) != "edu" {
		t.Fatalf("got %v err %v", got, err)
	}
}

func TestDeleteRecordsByLine(t *testing.T) {
	s := dnstest.Serve(t, seq(
		listCall("1", records(1, rec("1", "all", "A", "192.0.2.1", 600, "default"))),
		lineLists(map[string]string{"telecom": records(1, rec("2", "all", "A", "192.0.2.1", 600, "telecom"))}),
		// Only the telecom copy matches; the default-line record with the same value stays.
		call("DeleteDomainRecord", map[string]string{"RecordId": "2"}, `{"RequestId":"a","RecordId":"2"}`),
	)...)
	deleted, err := provider(t, s, nil).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnsx.OnLine(dnstest.A("all", "192.0.2.1", 600).RR(), "telecom"),
	})
	if err != nil || len(deleted) != 1 || dnsx.LineOf(deleted[0]) != "telecom" {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestUnknownLineIsUnsupported(t *testing.T) {
	s := dnstest.Serve(t)
	p := provider(t, s, nil)
	record := dnsx.LineRecord{Record: dnstest.A("all", "192.0.2.1", 600).RR(), Line: "satellite"}
	if _, err := p.SetRecords(context.Background(), "example.com.", []libdns.Record{record}); dnsx.Code(err) != "dns_unsupported" {
		t.Fatalf("set: %v", err)
	}
	if _, err := p.AppendRecords(context.Background(), "example.com.", []libdns.Record{record}); dnsx.Code(err) != "dns_unsupported" {
		t.Fatalf("append: %v", err)
	}
}
