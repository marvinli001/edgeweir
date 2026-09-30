package route53

// Responses follow the examples of the Route 53 API reference:
// https://docs.aws.amazon.com/Route53/latest/APIReference/API_ListResourceRecordSets.html
// https://docs.aws.amazon.com/Route53/latest/APIReference/API_ChangeResourceRecordSets.html
// https://docs.aws.amazon.com/Route53/latest/APIReference/API_ListHostedZonesByName.html
// https://docs.aws.amazon.com/Route53/latest/APIReference/API_ListHostedZones.html
// https://docs.aws.amazon.com/Route53/latest/APIReference/API_GetHostedZone.html
// Signature vectors: the AWS Signature Version 4 test suite
// (github.com/awslabs/aws-c-auth, tests/aws-signing-test-suite/v4).

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
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
	accessKey = "AKIAIOSFODNN7EXAMPLE"
	secretKey = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
	session   = "FwoGZXIvYXdzEBYaDExampleSessionToken0123456789abcdef"
	zoneID    = "Z1PA6795UKMFR9"
)

var clock = time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)

func provider(t *testing.T, s *dnstest.Server, extra map[string]string) *Provider {
	t.Helper()
	fields := map[string]string{"access_key_id": accessKey, "secret_access_key": secretKey}
	for k, v := range extra {
		fields[k] = v
	}
	p, err := New(fields, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	pp := p.(*Provider)
	pp.now = func() time.Time { return clock }
	return pp
}

// signed checks the SigV4 Authorization header of a received request by
// signing the same request again.
func signed(check func(t *testing.T, body []byte)) func(*testing.T, *http.Request, []byte) {
	return func(t *testing.T, r *http.Request, body []byte) {
		t.Helper()
		again, _ := http.NewRequest(r.Method, "http://"+r.Host+r.URL.RequestURI(), bytes.NewReader(body))
		if ct := r.Header.Get("Content-Type"); ct != "" {
			again.Header.Set("Content-Type", ct)
		}
		token := r.Header.Get("X-Amz-Security-Token")
		signV4(again, body, credentials{accessKey, secretKey, token}, "us-east-1", "route53", clock)
		got := r.Header.Get("Authorization")
		if got != again.Header.Get("Authorization") || !strings.HasPrefix(got, "AWS4-HMAC-SHA256 Credential="+accessKey+"/20260930/us-east-1/route53/aws4_request, SignedHeaders=") {
			t.Errorf("authorization %q, want %q", got, again.Header.Get("Authorization"))
		}
		if r.Header.Get("X-Amz-Date") != "20260930T120000Z" || r.Header.Get("User-Agent") != "edgeweir-certd/1" {
			t.Errorf("headers %v", r.Header)
		}
		if check != nil {
			check(t, body)
		}
	}
}

func xmlResponse(e dnstest.Exchange) dnstest.Exchange {
	e.ResponseHeader = map[string]string{"Content-Type": "text/xml"}
	if e.Check == nil {
		e.Check = signed(nil)
	}
	return e
}

const zoneList = `<?xml version="1.0" encoding="UTF-8"?>
<ListHostedZonesByNameResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
   <HostedZones>
      <HostedZone><Id>/hostedzone/Z2PRIVATE000001</Id><Name>example.com.</Name><CallerReference>internal</CallerReference>
         <Config><Comment>VPC view</Comment><PrivateZone>true</PrivateZone></Config><ResourceRecordSetCount>3</ResourceRecordSetCount></HostedZone>
      <HostedZone><Id>/hostedzone/Z1PA6795UKMFR9</Id><Name>example.com.</Name><CallerReference>MyUniqueIdentifier1</CallerReference>
         <Config><Comment>This is my first hosted zone.</Comment><PrivateZone>false</PrivateZone></Config><ResourceRecordSetCount>42</ResourceRecordSetCount></HostedZone>
      <HostedZone><Id>/hostedzone/Z3NET000000001</Id><Name>example.net.</Name><CallerReference>net</CallerReference>
         <Config><PrivateZone>false</PrivateZone></Config><ResourceRecordSetCount>2</ResourceRecordSetCount></HostedZone>
   </HostedZones>
   <IsTruncated>true</IsTruncated>
   <NextDNSName>example.org.</NextDNSName>
   <NextHostedZoneId>Z4ORG000000001</NextHostedZoneId>
   <MaxItems>100</MaxItems>
</ListHostedZonesByNameResponse>`

func zoneLookup() dnstest.Exchange {
	return xmlResponse(dnstest.Exchange{
		Method: "GET", Path: "/2013-04-01/hostedzonesbyname",
		Query:    map[string]string{"dnsname": "example.com.", "maxitems": "100", "hostedzoneid": ""},
		Response: zoneList,
	})
}

func sets(inner string, truncated string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<ListResourceRecordSetsResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
   <ResourceRecordSets>` + inner + `</ResourceRecordSets>` + truncated + `
   <MaxItems>300</MaxItems>
</ListResourceRecordSetsResponse>`
}

func set(name, typ string, ttl int, values ...string) string {
	out := "<ResourceRecordSet><Name>" + name + "</Name><Type>" + typ + "</Type><TTL>" + fmt.Sprint(ttl) + "</TTL><ResourceRecords>"
	for _, v := range values {
		out += "<ResourceRecord><Value>" + v + "</Value></ResourceRecord>"
	}
	return out + "</ResourceRecords></ResourceRecordSet>"
}

const notTruncated = "<IsTruncated>false</IsTruncated>"

func lookup(name, typ, response string) dnstest.Exchange {
	return xmlResponse(dnstest.Exchange{
		Method: "GET", Path: "/2013-04-01/hostedzone/" + zoneID + "/rrset",
		Query:    map[string]string{"name": name, "type": typ, "maxitems": "300"},
		Response: response,
	})
}

type batchRequest struct {
	XMLName xml.Name `xml:"ChangeResourceRecordSetsRequest"`
	Changes []struct {
		Action string    `xml:"Action"`
		Set    recordSet `xml:"ResourceRecordSet"`
	} `xml:"ChangeBatch>Changes>Change"`
}

// changes checks the change batch, one line per change:
// "ACTION name type ttl value|value" (alias: "alias=target", routing: "id=").
func changes(want ...string) dnstest.Exchange {
	return xmlResponse(dnstest.Exchange{
		Method: "POST", Path: "/2013-04-01/hostedzone/" + zoneID + "/rrset",
		Header: map[string]string{"Content-Type": "application/xml"},
		Check: signed(func(t *testing.T, body []byte) {
			var b batchRequest
			if err := xml.Unmarshal(body, &b); err != nil || b.XMLName.Space != xmlNS {
				t.Errorf("change batch %s: %v", body, err)
			}
			var got []string
			for _, c := range b.Changes {
				line := fmt.Sprintf("%s %s %s %d %s", c.Action, c.Set.Name, c.Set.Type, c.Set.TTL, strings.Join(c.Set.Values, "|"))
				if c.Set.Alias != nil {
					line += " alias=" + c.Set.Alias.DNSName
				}
				if c.Set.SetIdentifier != "" {
					line += " id=" + c.Set.SetIdentifier
				}
				got = append(got, strings.TrimSpace(line))
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("changes\n  %s\nwant\n  %s", strings.Join(got, "\n  "), strings.Join(want, "\n  "))
			}
		}),
		Response: `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
   <ChangeInfo><Id>/change/C2682N5HXP0BZ4</Id><Status>PENDING</Status><SubmittedAt>2026-09-30T12:00:00.000Z</SubmittedAt></ChangeInfo>
</ChangeResourceRecordSetsResponse>`,
	})
}

const aliasSet = `<ResourceRecordSet><Name>www.example.com.</Name><Type>A</Type>
   <AliasTarget><HostedZoneId>Z2FDTNDATAQYW2</HostedZoneId><DNSName>d111111abcdef8.cloudfront.net.</DNSName><EvaluateTargetHealth>false</EvaluateTargetHealth></AliasTarget>
</ResourceRecordSet>`

func weighted(name, id, value string) string {
	return `<ResourceRecordSet><Name>` + name + `</Name><Type>A</Type><SetIdentifier>` + id + `</SetIdentifier><Weight>50</Weight><TTL>60</TTL>
   <ResourceRecords><ResourceRecord><Value>` + value + `</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>`
}

func TestGetRecordsFollowsPagination(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(),
		xmlResponse(dnstest.Exchange{
			Method: "GET", Path: "/2013-04-01/hostedzone/" + zoneID + "/rrset",
			Query: map[string]string{"maxitems": "300", "name": "", "type": ""},
			Response: sets(
				set("example.com.", "NS", 172800, "ns-2048.awsdns-64.com.", "ns-2049.awsdns-65.net.")+
					set("example.com.", "SOA", 900, "ns-2048.awsdns-64.net. hostmaster.awsdns.com. 1 7200 900 1209600 86400")+
					set("example.com.", "TXT", 300, `"v=spf1 -all"`, `"part one " "part \"two\" \303\251"`),
				"<IsTruncated>true</IsTruncated><NextRecordName>\\052.example.com.</NextRecordName><NextRecordType>A</NextRecordType>"),
		}),
		xmlResponse(dnstest.Exchange{
			Method: "GET", Path: "/2013-04-01/hostedzone/" + zoneID + "/rrset",
			Query: map[string]string{"maxitems": "300", "name": `\052.example.com.`, "type": "A", "identifier": ""},
			Response: sets(
				set(`\052.example.com.`, "A", 60, "192.0.2.9")+
					set("cdn.example.com.", "CNAME", 3600, "edge.example.net")+
					aliasSet+weighted("api.example.com.", "blue", "192.0.2.20"),
				notTruncated),
		}),
	)
	records, err := provider(t, s, nil).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 7 {
		t.Fatalf("records: %+v", records)
	}
	for _, want := range [][3]string{
		{"@", "NS", "ns-2048.awsdns-64.com."}, {"@", "TXT", "v=spf1 -all"}, {"@", "TXT", `part one part "two" é`},
		{"*", "A", "192.0.2.9"}, {"cdn", "CNAME", "edge.example.net"},
	} {
		if !dnstest.Has(records, want[0], want[1], want[2]) {
			t.Errorf("missing %v in %+v", want, records)
		}
	}
	if dnstest.Has(records, "www", "A", "") || dnstest.Has(records, "api", "A", "192.0.2.20") {
		t.Fatalf("alias or routing-policy record listed: %+v", records)
	}
	if records[0].RR().TTL != 172800*time.Second {
		t.Fatalf("ttl %v", records[0].RR().TTL)
	}
}

func TestAppendRecordsExtendsTheRecordSet(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(),
		lookup("_acme-challenge.example.com.", "TXT", sets(
			set("_acme-challenge.example.com.", "TXT", 120, `"old"`)+set("_acme-challenge.www.example.com.", "TXT", 60, `"x"`), notTruncated)),
		lookup("_acme-challenge.cdn.example.com.", "TXT", sets(set("cdn.example.com.", "CNAME", 300, "edge.example.net."), notTruncated)),
		changes(
			`DELETE _acme-challenge.example.com. TXT 120 "old"`,
			`CREATE _acme-challenge.example.com. TXT 120 "old"|"new"`,
			`CREATE _acme-challenge.cdn.example.com. TXT 60 "fresh"`,
		),
	)
	added, err := provider(t, s, nil).AppendRecords(context.Background(), "example.com.", []libdns.Record{
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

func TestAppendRecordsRefusesRoutingPolicySets(t *testing.T) {
	s := dnstest.Serve(t, zoneLookup(), lookup("api.example.com.", "A", sets(weighted("api.example.com.", "blue", "192.0.2.20"), notTruncated)))
	_, err := provider(t, s, nil).AppendRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("api", "192.0.2.21", 60)})
	if !errors.Is(err, dnsx.ErrUnsupported) {
		t.Fatalf("err %v", err)
	}
}

func TestSetRecordsReplacesTheRecordSet(t *testing.T) {
	s := dnstest.Serve(t,
		xmlResponse(dnstest.Exchange{
			Method: "GET", Path: "/2013-04-01/hostedzone/" + zoneID,
			Response: `<?xml version="1.0" encoding="UTF-8"?>
<GetHostedZoneResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
   <HostedZone><Id>/hostedzone/Z1PA6795UKMFR9</Id><Name>example.com.</Name><CallerReference>MyUniqueIdentifier1</CallerReference>
      <Config><Comment>This is my first hosted zone.</Comment><PrivateZone>false</PrivateZone></Config><ResourceRecordSetCount>42</ResourceRecordSetCount></HostedZone>
   <DelegationSet><NameServers><NameServer>ns-2048.awsdns-64.com</NameServer></NameServers></DelegationSet>
</GetHostedZoneResponse>`,
		}),
		// 192.0.2.1 stays with a new TTL, 192.0.2.2 goes, 192.0.2.3 is added;
		// the TXT of the same name is another record set and stays.
		lookup("www.example.com.", "A", sets(
			set("www.example.com.", "A", 600, "192.0.2.1", "192.0.2.2")+set("www.example.com.", "TXT", 300, `"keep"`), notTruncated)),
		lookup("api.example.com.", "A", sets(
			weighted("api.example.com.", "blue", "192.0.2.20")+weighted("api.example.com.", "green", "192.0.2.21"), notTruncated)),
		lookup("same.example.com.", "A", sets(set("same.example.com.", "A", 60, "192.0.2.30"), notTruncated)),
		changes(
			"UPSERT www.example.com. A 60 192.0.2.1|192.0.2.3",
			"DELETE api.example.com. A 60 192.0.2.20 id=blue",
			"DELETE api.example.com. A 60 192.0.2.21 id=green",
			"CREATE api.example.com. A 60 192.0.2.7",
		),
	)
	out, err := provider(t, s, map[string]string{"hosted_zone_id": "/hostedzone/" + zoneID}).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60),
		dnstest.A("api", "192.0.2.7", 60), dnstest.A("same", "192.0.2.30", 60),
	})
	if err != nil || len(out) != 4 {
		t.Fatalf("out %v err %v", out, err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(),
		lookup("www.example.com.", "A", sets(set("www.example.com.", "A", 300, "192.0.2.1", "192.0.2.2"), notTruncated)),
		lookup("_acme-challenge.example.com.", "TXT", sets(set("_acme-challenge.example.com.", "TXT", 60, `"tok"`), notTruncated)),
		lookup("old.example.com.", "CNAME", sets(set("old.example.com.", "CNAME", 300, "gone.example.net."), notTruncated)),
		lookup("none.example.com.", "A", sets(set("www.example.com.", "A", 300, "192.0.2.1"), notTruncated)),
		changes(
			"DELETE www.example.com. A 300 192.0.2.1|192.0.2.2",
			"CREATE www.example.com. A 300 192.0.2.1",
			`DELETE _acme-challenge.example.com. TXT 60 "tok"`,
			"DELETE old.example.com. CNAME 300 gone.example.net.",
		),
	)
	deleted, err := provider(t, s, nil).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 300), dnstest.TXT("_acme-challenge", "tok", 60),
		libdns.RR{Name: "old", Type: "CNAME"}, dnstest.A("none", "192.0.2.1", 60),
	})
	if err != nil || len(deleted) != 3 || !dnstest.Has(deleted, "www", "A", "192.0.2.2") || !dnstest.Has(deleted, "old", "CNAME", "gone.example.net") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestWildcardNamesAreEscaped(t *testing.T) {
	s := dnstest.Serve(t,
		zoneLookup(),
		lookup(`\052.cdn.example.com.`, "A", sets("", notTruncated)),
		changes(`CREATE \052.cdn.example.com. A 60 192.0.2.8`),
	)
	if _, err := provider(t, s, nil).AppendRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("*.cdn", "192.0.2.8", 60)}); err != nil {
		t.Fatal(err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t,
		xmlResponse(dnstest.Exchange{
			Method: "GET", Path: "/2013-04-01/hostedzone", Query: map[string]string{"maxitems": "100", "marker": ""},
			Response: `<?xml version="1.0" encoding="UTF-8"?>
<ListHostedZonesResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
   <HostedZones>
      <HostedZone><Id>/hostedzone/Z111111QQQQQQQ</Id><Name>Example.com.</Name><CallerReference>MyUniqueIdentifier1</CallerReference>
         <Config><Comment>This is my first hosted zone.</Comment><PrivateZone>false</PrivateZone></Config><ResourceRecordSetCount>42</ResourceRecordSetCount></HostedZone>
      <HostedZone><Id>/hostedzone/Z2PRIVATE000001</Id><Name>internal.example.com.</Name><CallerReference>vpc</CallerReference>
         <Config><PrivateZone>true</PrivateZone></Config><ResourceRecordSetCount>3</ResourceRecordSetCount></HostedZone>
   </HostedZones>
   <IsTruncated>true</IsTruncated>
   <NextMarker>Z222222VVVVVVV</NextMarker>
   <MaxItems>100</MaxItems>
</ListHostedZonesResponse>`,
		}),
		xmlResponse(dnstest.Exchange{
			Method: "GET", Path: "/2013-04-01/hostedzone", Query: map[string]string{"maxitems": "100", "marker": "Z222222VVVVVVV"},
			Response: `<?xml version="1.0" encoding="UTF-8"?>
<ListHostedZonesResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
   <HostedZones><HostedZone><Id>/hostedzone/Z222222VVVVVVV</Id><Name>example.net.</Name><CallerReference>2</CallerReference>
      <Config><PrivateZone>false</PrivateZone></Config><ResourceRecordSetCount>2</ResourceRecordSetCount></HostedZone></HostedZones>
   <IsTruncated>false</IsTruncated><Marker>Z222222VVVVVVV</Marker><MaxItems>100</MaxItems>
</ListHostedZonesResponse>`,
		}),
	)
	zones, err := provider(t, s, nil).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func errorBody(code, message string) string {
	return `<?xml version="1.0"?>
<ErrorResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <Error><Type>Sender</Type><Code>` + code + `</Code><Message>` + message + `</Message></Error>
  <RequestId>b25f48e8-84fd-11e6-80d9-574e0c4664cb</RequestId>
</ErrorResponse>`
}

func TestErrors(t *testing.T) {
	ctx := context.Background()
	fail := func(status int, body string) *dnstest.Server {
		return dnstest.Serve(t, xmlResponse(dnstest.Exchange{Method: "GET", Path: "/2013-04-01/hostedzonesbyname", Status: status, Response: body}))
	}

	_, err := provider(t, fail(403, errorBody("InvalidClientTokenId", "The security token included in the request is invalid.")), nil).GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, secretKey)
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("invalid key: %v", err)
	}

	// SignatureDoesNotMatch echoes the canonical request, token included.
	s := dnstest.Serve(t, xmlResponse(dnstest.Exchange{
		Method: "GET", Path: "/2013-04-01/hostedzonesbyname", Status: 403,
		Header: map[string]string{"X-Amz-Security-Token": session},
		Check:  signed(nil), Response: errorBody("SignatureDoesNotMatch", "The Canonical String for this request should have been 'x-amz-security-token:"+session+"' secret "+secretKey),
	}))
	_, err = provider(t, s, map[string]string{"session_token": session}).GetRecords(ctx, "example.com.")
	dnstest.NoSecret(t, err, secretKey, session)
	if dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("signature: %v", err)
	}

	s = dnstest.Serve(t, xmlResponse(dnstest.Exchange{Method: "GET", Path: "/2013-04-01/hostedzone/" + zoneID, Status: 404, Response: errorBody("NoSuchHostedZone", "No hosted zone found with ID: "+zoneID)}))
	if _, err = provider(t, s, map[string]string{"hosted_zone_id": zoneID}).GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown hosted zone: %v", err)
	}

	s = dnstest.Serve(t, xmlResponse(dnstest.Exchange{Method: "GET", Path: "/2013-04-01/hostedzone/" + zoneID,
		Response: `<GetHostedZoneResponse><HostedZone><Id>/hostedzone/Z1PA6795UKMFR9</Id><Name>example.org.</Name><Config><PrivateZone>false</PrivateZone></Config></HostedZone></GetHostedZoneResponse>`}))
	if _, err = provider(t, s, map[string]string{"hosted_zone_id": zoneID}).GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("hosted zone of another name: %v", err)
	}

	s = fail(200, `<ListHostedZonesByNameResponse><HostedZones><HostedZone><Id>/hostedzone/Z3NET000000001</Id><Name>example.net.</Name><Config><PrivateZone>false</PrivateZone></Config></HostedZone></HostedZones><IsTruncated>false</IsTruncated></ListHostedZonesByNameResponse>`)
	if _, err = provider(t, s, nil).GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("no zone: %v", err)
	}

	if _, err = provider(t, fail(400, errorBody("Throttling", "Rate exceeded")), nil).GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrRateLimited) {
		t.Fatalf("throttling: %v", err)
	}
	if _, err = provider(t, fail(503, `Service Unavailable`), nil).GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}

	s = dnstest.Serve(t, zoneLookup(), lookup("www.example.com.", "A", sets("", notTruncated)), xmlResponse(dnstest.Exchange{
		Method: "POST", Path: "/2013-04-01/hostedzone/" + zoneID + "/rrset", Status: 400,
		Response: `<?xml version="1.0" encoding="UTF-8"?>
<InvalidChangeBatch xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <Messages><Message>Tried to create resource record set [name='www.example.com.', type='A'] but it already exists</Message></Messages>
  <RequestId>b25f48e8-84fd-11e6-80d9-574e0c4664cb</RequestId>
</InvalidChangeBatch>`,
	}))
	_, err = provider(t, s, nil).SetRecords(ctx, "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.1", 60)})
	if dnsx.Code(err) != "dns_provider_error" || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("invalid change batch: %v", err)
	}

	for _, fields := range []map[string]string{
		{"access_key_id": "short", "secret_access_key": secretKey},
		{"access_key_id": accessKey, "secret_access_key": "has space " + secretKey},
		{"access_key_id": accessKey, "secret_access_key": secretKey, "session_token": "line\nbreak" + session},
		{"access_key_id": accessKey, "secret_access_key": secretKey, "hosted_zone_id": "z1/../../x"},
		{"access_key_id": accessKey, "secret_access_key": secretKey, "partition": "aws-xx"},
	} {
		_, err := New(fields, dnsx.Options{})
		if !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed credentials accepted: %v", fields)
		}
		dnstest.NoSecret(t, err, secretKey, session)
	}
}

func TestSigV4TestSuite(t *testing.T) {
	c := credentials{accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"}
	at := time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)

	// get-vanilla-query-order-key-case
	req, _ := http.NewRequest("GET", "https://example.amazonaws.com/?Param2=value2&Param1=value1", nil)
	canonical := signV4(req, nil, c, "us-east-1", "service", at)
	if want := "GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; canonical != want {
		t.Fatalf("canonical request\n%s\nwant\n%s", canonical, want)
	}
	if got, want := req.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"; got != want {
		t.Fatalf("authorization %s", got)
	}

	// post-sts-header-before
	c.token = "AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA=="
	req, _ = http.NewRequest("POST", "https://example.amazonaws.com/", nil)
	signV4(req, nil, c, "us-east-1", "service", at)
	if got, want := req.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead"; got != want {
		t.Fatalf("authorization %s", got)
	}
	if req.Header.Get("X-Amz-Security-Token") != c.token {
		t.Fatal("security token header missing")
	}
}

func TestCanonicalRequestOfRoute53Calls(t *testing.T) {
	p, _ := New(map[string]string{"access_key_id": accessKey, "secret_access_key": secretKey}, dnsx.Options{})
	pp := p.(*Provider)
	pp.now = func() time.Time { return clock }
	req, canonical, err := pp.newRequest(context.Background(), "GET", "/hostedzone/"+zoneID+"/rrset", [][2]string{{"name", `\052.example.com.`}, {"type", "TXT"}, {"maxitems", "300"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if req.URL.String() != "https://route53.amazonaws.com/2013-04-01/hostedzone/Z1PA6795UKMFR9/rrset?name=%5C052.example.com.&type=TXT&maxitems=300" {
		t.Fatalf("url %s", req.URL)
	}
	want := "GET\n/2013-04-01/hostedzone/Z1PA6795UKMFR9/rrset\nmaxitems=300&name=%5C052.example.com.&type=TXT\n" +
		"host:route53.amazonaws.com\nx-amz-date:20260930T120000Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	if canonical != want {
		t.Fatalf("canonical request\n%s\nwant\n%s", canonical, want)
	}

	body := []byte(`<ChangeResourceRecordSetsRequest/>`)
	sum := sha256.Sum256(body)
	cn, _ := New(map[string]string{"access_key_id": accessKey, "secret_access_key": secretKey, "session_token": session, "partition": "aws-cn"}, dnsx.Options{})
	cp := cn.(*Provider)
	cp.now = func() time.Time { return clock }
	req, canonical, _ = cp.newRequest(context.Background(), "POST", "/hostedzone/"+zoneID+"/rrset", nil, body)
	want = "POST\n/2013-04-01/hostedzone/Z1PA6795UKMFR9/rrset\n\ncontent-type:application/xml\nhost:route53.amazonaws.com.cn\n" +
		"x-amz-date:20260930T120000Z\nx-amz-security-token:" + session + "\n\ncontent-type;host;x-amz-date;x-amz-security-token\n" + hex.EncodeToString(sum[:])
	if canonical != want {
		t.Fatalf("canonical request\n%s\nwant\n%s", canonical, want)
	}
	if !strings.HasPrefix(req.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential="+accessKey+"/20260930/cn-northwest-1/route53/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=") {
		t.Fatalf("authorization %s", req.Header.Get("Authorization"))
	}
}

func TestTXTQuoting(t *testing.T) {
	long := strings.Repeat("a", 300)
	quoted := quoteTXT(long + `"\` + "\x01")
	if quoted != `"`+strings.Repeat("a", 255)+`" "`+strings.Repeat("a", 45)+`\"\\\001"` {
		t.Fatalf("quoted %s", quoted)
	}
	if unquoteTXT(quoted) != long+`"\`+"\x01" || unquoteTXT(`"ex\344mple"`) != "ex\xe4mple" || quoteTXT("") != `""` {
		t.Fatal("unquote")
	}
}
