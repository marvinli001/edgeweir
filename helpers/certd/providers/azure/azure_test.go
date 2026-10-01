package azure

// Responses follow the Azure DNS REST API reference (api-version 2018-05-01)
// and its examples:
// https://learn.microsoft.com/rest/api/dns/record-sets/list-all-by-dns-zone
// https://learn.microsoft.com/rest/api/dns/record-sets/get
// https://learn.microsoft.com/rest/api/dns/record-sets/create-or-update
// https://learn.microsoft.com/rest/api/dns/record-sets/delete
// https://learn.microsoft.com/rest/api/dns/zones/get
// https://learn.microsoft.com/rest/api/dns/zones/list-by-resource-group
// and the Microsoft identity platform client credentials flow:
// https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	tenant       = "aaaabbbb-0000-cccc-1111-dddd2222eeee"
	clientID     = "00001111-aaaa-2222-bbbb-3333cccc4444"
	secret       = "A1bC2dE3fH4iJ5kL6mN7oP8qR9sT0u~x.y_z"
	subscription = "aaaa0a0a-bb1b-cc2c-dd3d-eeeeee4e4e4e"
	armToken     = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.test-arm-token"
	groupURL     = "/subscriptions/" + subscription + "/resourceGroups/rg1/providers/Microsoft.Network/dnsZones"
	zonePath     = groupURL + "/example.com"
)

var clock = time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)

// rewrite points nextLink URLs of the recorded answers at the test server.
type rewrite struct {
	base http.RoundTripper
	url  string
}

func (r rewrite) RoundTrip(req *http.Request) (*http.Response, error) {
	res, err := r.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	body = bytes.ReplaceAll(body, []byte("https://management.azure.com"), []byte(r.url))
	res.Body = io.NopCloser(bytes.NewReader(body))
	res.ContentLength = int64(len(body))
	return res, nil
}

func fields() map[string]string {
	return map[string]string{"tenant_id": tenant, "client_id": clientID, "client_secret": secret, "subscription_id": subscription, "resource_group": "rg1"}
}

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	client := &http.Client{Transport: rewrite{s.Client().Transport, s.URL}}
	p, err := New(fields(), dnsx.Options{BaseURL: s.URL, HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	pp := p.(*Provider)
	pp.now = func() time.Time { return clock }
	return pp
}

func tokenCall() dnstest.Exchange {
	return dnstest.Exchange{
		Method: "POST", Path: "/" + tenant + "/oauth2/v2.0/token",
		Header: map[string]string{"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "edgeweir-certd/1"},
		Form: map[string]string{"client_id": clientID, "client_secret": secret, "scope": "https://management.azure.com/.default",
			"grant_type": "client_credentials"},
		Response: `{"token_type":"Bearer","expires_in":3599,"access_token":"` + armToken + `"}`,
	}
}

func arm(method, path string, e dnstest.Exchange) dnstest.Exchange {
	e.Method, e.Path = method, path
	if e.Query == nil {
		e.Query = map[string]string{}
	}
	e.Query["api-version"] = "2018-05-01"
	if e.Header == nil {
		e.Header = map[string]string{}
	}
	e.Header["Authorization"] = "Bearer " + armToken
	e.Header["User-Agent"] = "edgeweir-certd/1"
	return e
}

func zoneGet() dnstest.Exchange {
	return arm("GET", zonePath, dnstest.Exchange{Response: `{"id":"` + zonePath + `","etag":"00000000-0000-0000-0000-000000000000",
 "location":"global","name":"example.com","type":"Microsoft.Network/dnsZones",
 "properties":{"maxNumberOfRecordSets":5000,"numberOfRecordSets":8,"nameServers":["ns1-01.azure-dns.com","ns2-01.azure-dns.net"],"zoneType":"Public"}}`})
}

func rrset(typ, name, etag, properties string) string {
	return `{"id":"` + zonePath + `/` + typ + `/` + name + `","etag":"` + etag + `","name":"` + name + `","type":"Microsoft.Network/dnsZones/` + typ + `","properties":` + properties + `}`
}

func get(typ, name, response string) dnstest.Exchange {
	e := dnstest.Exchange{Response: response}
	if response == "" {
		e.Status, e.Response = 404, `{"error":{"code":"NotFound","message":"The resource record '`+name+`' does not exist in resource group 'rg1' of subscription '`+subscription+`'."}}`
	}
	return arm("GET", zonePath+"/"+typ+"/"+name, e)
}

// put checks the PUT body exactly and the concurrency header.
func put(typ, name string, header map[string]string, want string) dnstest.Exchange {
	return arm("PUT", zonePath+"/"+typ+"/"+name, dnstest.Exchange{
		Header: header,
		Check: func(t *testing.T, r *http.Request, body []byte) {
			var got, expected any
			if json.Unmarshal(body, &got) != nil || json.Unmarshal([]byte(want), &expected) != nil || !reflect.DeepEqual(got, expected) {
				t.Errorf("PUT %s/%s\n  %s\nwant\n  %s", typ, name, body, want)
			}
			if header["If-Match"] == "" && r.Header.Get("If-Match") != "" || header["If-None-Match"] == "" && r.Header.Get("If-None-Match") != "" {
				t.Errorf("unexpected concurrency header %v", r.Header)
			}
		},
		Status: 200, Response: rrset(typ, name, "new-etag", `{"TTL":60}`),
	})
}

const (
	wwwA = `{"TTL":600,"fqdn":"www.example.com.","provisioningState":"Succeeded","ARecords":[{"ipv4Address":"192.0.2.1"},{"ipv4Address":"192.0.2.2"}]}`
	acme = `{"metadata":{"owner":"certd"},"TTL":120,"fqdn":"_acme-challenge.example.com.","TXTRecords":[{"value":["old"]}]}`
)

func TestGetRecordsFollowsNextLink(t *testing.T) {
	s := dnstest.Serve(t,
		tokenCall(),
		zoneGet(),
		arm("GET", zonePath+"/all", dnstest.Exchange{Query: map[string]string{"$skipToken": ""}, Response: `{
 "nextLink":"https://management.azure.com` + zonePath + `/all?api-version=2018-05-01&$skipToken=skipToken",
 "value":[` + strings.Join([]string{
			rrset("SOA", "@", "e0", `{"TTL":3600,"fqdn":"example.com.","SOARecord":{"host":"ns1-01.azure-dns.com.","email":"azuredns-hostmaster.microsoft.com","serialNumber":1,"refreshTime":3600,"retryTime":300,"expireTime":2419200,"minimumTTL":300}}`),
			rrset("NS", "@", "e1", `{"TTL":172800,"fqdn":"example.com.","NSRecords":[{"nsdname":"ns1-01.azure-dns.com."},{"nsdname":"ns2-01.azure-dns.net."}]}`),
			rrset("A", "www", "e2", wwwA),
			rrset("TXT", "@", "e3", `{"TTL":300,"fqdn":"example.com.","TXTRecords":[{"value":["v=spf1 -all"]},{"value":["part one ","part two"]}]}`),
		}, ",") + `]}`}),
		arm("GET", zonePath+"/all", dnstest.Exchange{Query: map[string]string{"$skipToken": "skipToken"}, Response: `{"value":[` + strings.Join([]string{
			rrset("CNAME", "cdn", "e4", `{"TTL":3600,"fqdn":"cdn.example.com.","CNAMERecord":{"cname":"edge.example.net"}}`),
			rrset("A", "@", "e5", `{"TTL":3600,"fqdn":"example.com.","targetResource":{"id":"/subscriptions/726f8cd6-6459-4db4-8e6d-2cd2716904e2/resourceGroups/test/providers/Microsoft.Network/trafficManagerProfiles/testpp2"},"provisioningState":"Succeeded"}`),
			rrset("MX", "@", "e6", `{"TTL":3600,"fqdn":"example.com.","MXRecords":[{"preference":0,"exchange":"mail.contoso.com"}]}`),
			rrset("CAA", "@", "e7", `{"TTL":3600,"fqdn":"example.com.","caaRecords":[{"flags":0,"tag":"issue","value":"ca.contoso.com"}]}`),
			rrset("AAAA", "www", "e8", `{"TTL":3600,"fqdn":"www.example.com.","AAAARecords":[{"ipv6Address":"2001:db8::1"}]}`),
			rrset("A", "*", "e9", `{"TTL":60,"fqdn":"*.example.com.","ARecords":[{"ipv4Address":"192.0.2.9"}]}`),
		}, ",") + `]}`}),
	)
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 12 {
		t.Fatalf("records: %+v", records)
	}
	for _, want := range [][3]string{
		{"@", "NS", "ns1-01.azure-dns.com."}, {"www", "A", "192.0.2.2"}, {"@", "TXT", "v=spf1 -all"}, {"@", "TXT", "part one part two"},
		{"cdn", "CNAME", "edge.example.net"}, {"@", "MX", "0 mail.contoso.com"}, {"@", "CAA", `0 issue "ca.contoso.com"`},
		{"www", "AAAA", "2001:db8::1"}, {"*", "A", "192.0.2.9"},
		{"@", "SOA", "ns1-01.azure-dns.com. azuredns-hostmaster.microsoft.com 1 3600 300 2419200 300"},
	} {
		if !dnstest.Has(records, want[0], want[1], want[2]) {
			t.Errorf("missing %v in %+v", want, records)
		}
	}
	for _, r := range records {
		if rr := r.RR(); rr.Name == "@" && rr.Type == "A" {
			t.Fatalf("alias record set listed: %+v", rr)
		}
	}
	if records[1].RR().TTL != 172800*time.Second {
		t.Fatalf("ttl %v", records[1].RR().TTL)
	}
}

func TestAppendRecordsExtendsTheRecordSet(t *testing.T) {
	s := dnstest.Serve(t,
		tokenCall(),
		zoneGet(),
		get("TXT", "_acme-challenge", rrset("TXT", "_acme-challenge", "etag-1", acme)),
		put("TXT", "_acme-challenge", map[string]string{"If-Match": "etag-1"},
			`{"properties":{"TTL":120,"metadata":{"owner":"certd"},"TXTRecords":[{"value":["old"]},{"value":["new"]}]}}`),
		get("TXT", "_acme-challenge.cdn", ""),
		put("TXT", "_acme-challenge.cdn", map[string]string{"If-None-Match": "*"}, `{"properties":{"TTL":60,"TXTRecords":[{"value":["fresh"]}]}}`),
	)
	added, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", "old", 60), dnstest.TXT("_acme-challenge", "new", 60),
		dnstest.TXT("_acme-challenge.cdn", "fresh", 60),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(added) != 2 || !dnstest.Has(added, "_acme-challenge", "TXT", "new") || added[0].RR().TTL != 120*time.Second {
		t.Fatalf("added %+v", added)
	}
}

func TestSetRecordsPutsWholeRecordSets(t *testing.T) {
	alias := rrset("A", "@", "etag-alias", `{"TTL":3600,"targetResource":{"id":"/subscriptions/726f8cd6-6459-4db4-8e6d-2cd2716904e2/resourceGroups/test/providers/Microsoft.Network/trafficManagerProfiles/testpp2"}}`)
	long := strings.Repeat("x", 300)
	s := dnstest.Serve(t,
		tokenCall(),
		zoneGet(),
		// 192.0.2.1 stays with a new TTL, 192.0.2.2 goes, 192.0.2.3 is added.
		get("A", "www", rrset("A", "www", "etag-www", wwwA)),
		put("A", "www", map[string]string{"If-Match": "etag-www"}, `{"properties":{"TTL":60,"ARecords":[{"ipv4Address":"192.0.2.1"},{"ipv4Address":"192.0.2.3"}]}}`),
		get("A", "@", alias),
		put("A", "@", map[string]string{"If-Match": "etag-alias"}, `{"properties":{"TTL":60,"ARecords":[{"ipv4Address":"192.0.2.7"}]}}`),
		get("A", "same", rrset("A", "same", "etag-same", `{"TTL":60,"ARecords":[{"ipv4Address":"192.0.2.30"}]}`)),
		get("CNAME", "cdn", ""),
		put("CNAME", "cdn", map[string]string{"If-None-Match": "*"}, `{"properties":{"TTL":300,"CNAMERecord":{"cname":"edge.example.net"}}}`),
		get("TXT", "long", ""),
		put("TXT", "long", map[string]string{"If-None-Match": "*"}, `{"properties":{"TTL":60,"TXTRecords":[{"value":["`+long[:255]+`","`+long[255:]+`"]}]}}`),
	)
	out, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60), dnstest.A("@", "192.0.2.7", 60),
		dnstest.A("same", "192.0.2.30", 60), dnstest.CNAME("cdn", "edge.example.net.", 300), dnstest.TXT("long", long, 60),
	})
	if err != nil || len(out) != 6 {
		t.Fatalf("out %v err %v", out, err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		tokenCall(),
		zoneGet(),
		get("A", "www", rrset("A", "www", "etag-www", wwwA)),
		put("A", "www", map[string]string{"If-Match": "etag-www"}, `{"properties":{"TTL":600,"ARecords":[{"ipv4Address":"192.0.2.1"}]}}`),
		get("TXT", "_acme-challenge", rrset("TXT", "_acme-challenge", "etag-acme", acme)),
		arm("DELETE", zonePath+"/TXT/_acme-challenge", dnstest.Exchange{Header: map[string]string{"If-Match": "etag-acme"}}),
		get("CNAME", "old", rrset("CNAME", "old", "etag-old", `{"TTL":300,"CNAMERecord":{"cname":"gone.example.net"}}`)),
		arm("DELETE", zonePath+"/CNAME/old", dnstest.Exchange{Header: map[string]string{"If-Match": "etag-old"}, Status: 204}),
		get("A", "none", ""),
	)
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 600), dnstest.TXT("_acme-challenge", "old", 60),
		libdns.RR{Name: "old", Type: "CNAME"}, dnstest.A("none", "192.0.2.1", 60),
	})
	if err != nil || len(deleted) != 3 || !dnstest.Has(deleted, "www", "A", "192.0.2.2") || !dnstest.Has(deleted, "old", "CNAME", "gone.example.net") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t,
		tokenCall(),
		arm("GET", groupURL, dnstest.Exchange{Query: map[string]string{"$skipToken": ""}, Response: `{
 "nextLink":"https://management.azure.com` + groupURL + `?api-version=2018-05-01&$skipToken=skipToken",
 "value":[{"id":"` + groupURL + `/zone1.example","name":"Zone1.example","type":"Microsoft.Network/dnsZones","location":"global","properties":{"numberOfRecordSets":2}},
  {"id":"` + groupURL + `/internal.example","name":"internal.example","type":"Microsoft.Network/dnsZones","location":"global","properties":{"zoneType":"Private"}}]}`}),
		arm("GET", groupURL, dnstest.Exchange{Query: map[string]string{"$skipToken": "skipToken"}, Response: `{"value":[
  {"id":"` + groupURL + `/zone2.example","name":"zone2.example","type":"Microsoft.Network/dnsZones","location":"global","properties":{"zoneType":"Public"}}]}`}),
	)
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "zone1.example." || zones[1].Name != "zone2.example." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	ctx := context.Background()

	s := dnstest.Serve(t, dnstest.Exchange{Method: "POST", Path: "/" + tenant + "/oauth2/v2.0/token", Status: 401,
		Response: `{"error":"invalid_client","error_description":"AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app '` + clientID + `'. Received '` + secret + `'.\r\nTrace ID: 0000aaaa-11bb-cccc-dd22-eeeeee333333\r\nCorrelation ID: aaaa0000-bb11-2222-33cc-444444dddddd\r\nTimestamp: 2026-09-30 12:00:00Z","error_codes":[7000215],"timestamp":"2026-09-30 12:00:00Z","trace_id":"0000aaaa-11bb-cccc-dd22-eeeeee333333","correlation_id":"aaaa0000-bb11-2222-33cc-444444dddddd"}`})
	_, err := provider(t, s).GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, secret)
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" || !strings.Contains(err.Error(), "AADSTS7000215") {
		t.Fatalf("invalid secret: %v", err)
	}

	zoneFails := func(status int, body string) error {
		s := dnstest.Serve(t, tokenCall(), arm("GET", zonePath, dnstest.Exchange{Status: status, Response: body, ResponseHeader: map[string]string{"Retry-After": "5"}}))
		_, err := provider(t, s).GetRecords(ctx, "example.com.")
		dnstest.NoSecret(t, err, secret, armToken)
		return err
	}
	if err = zoneFails(403, `{"error":{"code":"AuthorizationFailed","message":"The client '`+clientID+`' with object id '`+clientID+`' does not have authorization to perform action 'Microsoft.Network/dnszones/read' over scope '`+zonePath+`' or the scope is invalid."}}`); dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("403: %v", err)
	}
	if err = zoneFails(404, `{"error":{"code":"ResourceNotFound","message":"The Resource 'Microsoft.Network/dnszones/example.com' under resource group 'rg1' was not found."}}`); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if err = zoneFails(404, `{"error":{"code":"ResourceGroupNotFound","message":"Resource group 'rg1' could not be found."}}`); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown resource group: %v", err)
	}
	if err = zoneFails(200, `{"name":"example.com","properties":{"zoneType":"Private"}}`); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("private zone: %v", err)
	}
	if err = zoneFails(429, `{"error":{"code":"TooManyRequests","message":"The request is being throttled."}}`); !errors.Is(err, dnsx.ErrRateLimited) {
		t.Fatalf("429: %v", err)
	}
	if err = zoneFails(503, `upstream unavailable`); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}

	s = dnstest.Serve(t, tokenCall(), zoneGet(), get("A", "www", rrset("A", "www", "etag-www", wwwA)),
		arm("PUT", zonePath+"/A/www", dnstest.Exchange{Status: 412, Response: `{"error":{"code":"PreconditionFailed","message":"The Etag provided in the request does not match the current Etag of the resource."}}`}))
	_, err = provider(t, s).SetRecords(ctx, "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.9", 60)})
	if dnsx.Code(err) != "dns_provider_error" || !strings.Contains(err.Error(), "PreconditionFailed") {
		t.Fatalf("412: %v", err)
	}

	// A nextLink on another host is not followed.
	s = dnstest.Serve(t, tokenCall(), zoneGet(), arm("GET", zonePath+"/all", dnstest.Exchange{Response: `{"value":[],"nextLink":"https://attacker.example/steal?api-version=2018-05-01"}`}))
	if _, err = provider(t, s).GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_error" {
		t.Fatalf("foreign nextLink: %v", err)
	}

	// Names that would add path segments are refused before any request.
	s = dnstest.Serve(t, tokenCall(), zoneGet())
	if _, err = provider(t, s).SetRecords(ctx, "example.com.", []libdns.Record{dnstest.A("a/../../x", "192.0.2.1", 60)}); !errors.Is(err, dnsx.ErrInvalid) {
		t.Fatalf("record name: %v", err)
	}
	if _, err = provider(t, dnstest.Serve(t)).GetRecords(ctx, "example.com/../x."); !errors.Is(err, dnsx.ErrInvalid) {
		t.Fatalf("zone name: %v", err)
	}

	for key, value := range map[string]string{
		"tenant_id": "common", "client_id": "not-a-guid", "subscription_id": "../../providers", "client_secret": "line\nbreak",
	} {
		assertInvalid(t, key, value)
	}
	for _, tenantID := range []string{"evil.example/x", "user@contoso.onmicrosoft.com", "contoso.onmicrosoft.com?x=1", "contoso.onmicrosoft.com#"} {
		assertInvalid(t, "tenant_id", tenantID)
	}
	for _, rg := range []string{"..", "rg.", "rg/../x", "rg?api-version=1", "rg%2F", strings.Repeat("r", 91), ""} {
		assertInvalid(t, "resource_group", rg)
	}
	f := fields()
	f["tenant_id"], f["resource_group"] = "contoso.onmicrosoft.com", "my-rg_(prod).1"
	if _, err := New(f, dnsx.Options{}); err != nil {
		t.Fatalf("valid fields refused: %v", err)
	}
}

func assertInvalid(t *testing.T, key, value string) {
	t.Helper()
	f := fields()
	f[key] = value
	_, err := New(f, dnsx.Options{})
	if !errors.Is(err, dnsx.ErrInvalid) {
		t.Fatalf("%s %q accepted: %v", key, value, err)
	}
	dnstest.NoSecret(t, err, secret)
}
