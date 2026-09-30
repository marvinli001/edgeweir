package googleclouddns

// Responses follow the Cloud DNS API v1 reference and its examples:
// https://cloud.google.com/dns/docs/reference/rest/v1/resourceRecordSets/list
// https://cloud.google.com/dns/docs/reference/rest/v1/changes/create
// https://cloud.google.com/dns/docs/reference/rest/v1/managedZones/list
// https://cloud.google.com/dns/docs/reference/rest/v1/managedZones/get
// and the OAuth 2.0 service account flow:
// https://developers.google.com/identity/protocols/oauth2/service-account#httprest

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	email       = "certd@my-project.iam.gserviceaccount.com"
	keyID       = "0123456789abcdef0123456789abcdef01234567"
	accessToken = "ya29.c.test-access-token"
)

var (
	clock   = time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	testKey = generate(2048)
)

func generate(bits int) *rsa.PrivateKey {
	key, err := rsa.GenerateKey(rand.Reader, bits)
	if err != nil {
		panic(err)
	}
	return key
}

func keyPEM(key *rsa.PrivateKey) string {
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

func keyFile(edit func(map[string]string)) string {
	file := map[string]string{
		"type": "service_account", "project_id": "my-project", "private_key_id": keyID, "private_key": keyPEM(testKey),
		"client_email": email, "client_id": "123456789012345678901",
		"auth_uri": "https://accounts.google.com/o/oauth2/auth", "token_uri": "https://oauth2.googleapis.com/token",
		"universe_domain": "googleapis.com",
	}
	if edit != nil {
		edit(file)
	}
	raw, _ := json.Marshal(file)
	return string(raw)
}

func provider(t *testing.T, s *dnstest.Server, extra map[string]string) *Provider {
	t.Helper()
	fields := map[string]string{"service_account_json": keyFile(nil)}
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

func decodeSegment(t *testing.T, segment string, out any) {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil || json.Unmarshal(raw, out) != nil {
		t.Fatalf("JWT segment %q: %v", segment, err)
	}
}

// checkAssertion verifies the JWT header, claims and RS256 signature of a
// token request made at the given time.
func checkAssertion(at time.Time) func(*testing.T, *http.Request, []byte) {
	return func(t *testing.T, _ *http.Request, body []byte) { assertionAt(t, at, body) }
}

func assertionAt(t *testing.T, at time.Time, body []byte) {
	form, _ := url.ParseQuery(string(body))
	parts := strings.Split(form.Get("assertion"), ".")
	if len(parts) != 3 {
		t.Fatalf("assertion %q", form.Get("assertion"))
	}
	var header, claims map[string]any
	decodeSegment(t, parts[0], &header)
	decodeSegment(t, parts[1], &claims)
	if want := (map[string]any{"alg": "RS256", "typ": "JWT", "kid": keyID}); !reflect.DeepEqual(header, want) {
		t.Errorf("JWT header %v", header)
	}
	iat := float64(at.Unix() - 30)
	if want := (map[string]any{"iss": email, "scope": "https://www.googleapis.com/auth/ndev.clouddns.readwrite", "aud": "https://oauth2.googleapis.com/token", "iat": iat, "exp": iat + 3600}); !reflect.DeepEqual(claims, want) {
		t.Errorf("JWT claims %v", claims)
	}
	signature, _ := base64.RawURLEncoding.DecodeString(parts[2])
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(&testKey.PublicKey, crypto.SHA256, digest[:], signature) != nil {
		t.Error("JWT signature does not verify")
	}
}

func tokenCall() dnstest.Exchange { return tokenCallAt(clock) }

func tokenCallAt(at time.Time) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "POST", Path: "/token",
		Header:   map[string]string{"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "edgeweir-certd/1"},
		Form:     map[string]string{"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer"},
		Check:    checkAssertion(at),
		Response: `{"access_token":"` + accessToken + `","scope":"https://www.googleapis.com/auth/ndev.clouddns.readwrite","token_type":"Bearer","expires_in":3599}`,
	}
}

func api(method, path string, e dnstest.Exchange) dnstest.Exchange {
	e.Method, e.Path = method, "/dns/v1/projects/my-project"+path
	if e.Header == nil {
		e.Header = map[string]string{}
	}
	e.Header["Authorization"] = "Bearer " + accessToken
	e.Header["User-Agent"] = "edgeweir-certd/1"
	return e
}

const zones = `{"kind":"dns#managedZonesListResponse","managedZones":[
 {"name":"example-internal","dnsName":"example.com.","description":"","id":"1111111111111111111","visibility":"private","kind":"dns#managedZone"},
 {"name":"example-com","dnsName":"example.com.","description":"","id":"6151096870552453390",
  "nameServers":["ns-cloud-b1.googledomains.com.","ns-cloud-b2.googledomains.com."],"creationTime":"2022-10-23T18:12:27.817Z",
  "visibility":"public","cloudLoggingConfig":{"kind":"dns#managedZoneCloudLoggingConfig"},"kind":"dns#managedZone"}]}`

func zoneLookup() dnstest.Exchange {
	return api("GET", "/managedZones", dnstest.Exchange{Query: map[string]string{"dnsName": "example.com.", "pageToken": ""}, Response: zones})
}

func rrsets(sets ...string) string {
	return `{"kind":"dns#resourceRecordSetsListResponse","rrsets":[` + strings.Join(sets, ",") + `]}`
}

func lookup(name, typ string, sets ...string) dnstest.Exchange {
	return api("GET", "/managedZones/example-com/rrsets", dnstest.Exchange{
		Query: map[string]string{"name": name, "type": typ}, Response: rrsets(sets...),
	})
}

// changes checks the changes.create body exactly.
func changes(want string) dnstest.Exchange {
	return api("POST", "/managedZones/example-com/changes", dnstest.Exchange{
		Header: map[string]string{"Content-Type": "application/json"},
		Check: func(t *testing.T, _ *http.Request, body []byte) {
			var got, expected any
			if json.Unmarshal(body, &got) != nil || json.Unmarshal([]byte(want), &expected) != nil || !reflect.DeepEqual(got, expected) {
				t.Errorf("change\n  %s\nwant\n  %s", body, want)
			}
		},
		Response: `{"kind":"dns#change","additions":[],"deletions":[],"startTime":"2026-09-30T12:00:00.000Z","id":"7","status":"pending"}`,
	})
}

const (
	wwwA     = `{"name":"www.example.com.","type":"A","ttl":600,"rrdatas":["192.0.2.1","192.0.2.2"],"signatureRrdatas":[],"kind":"dns#resourceRecordSet"}`
	wwwTXT   = `{"name":"www.example.com.","type":"TXT","ttl":300,"rrdatas":["\"keep\""],"signatureRrdatas":[],"kind":"dns#resourceRecordSet"}`
	geoA     = `{"name":"api.example.com.","type":"A","ttl":60,"routingPolicy":{"geo":{"items":[{"location":"us-east1","rrdatas":["192.0.2.20"]},{"location":"europe-west1","rrdatas":["192.0.2.21"]}]},"kind":"dns#rRSetRoutingPolicy"},"kind":"dns#resourceRecordSet"}`
	acmeTXT  = `{"name":"_acme-challenge.example.com.","type":"TXT","ttl":120,"rrdatas":["\"old\""],"signatureRrdatas":[],"kind":"dns#resourceRecordSet"}`
	cdnCNAME = `{"name":"cdn.example.com.","type":"CNAME","ttl":300,"rrdatas":["edge.example.net."],"signatureRrdatas":[],"kind":"dns#resourceRecordSet"}`
)

func TestGetRecordsFollowsPagination(t *testing.T) {
	s := dnstest.Serve(t,
		tokenCall(),
		zoneLookup(),
		api("GET", "/managedZones/example-com/rrsets", dnstest.Exchange{
			Query: map[string]string{"pageToken": "", "name": ""},
			Response: `{"kind":"dns#resourceRecordSetsListResponse","nextPageToken":"page-2","rrsets":[
 {"name":"example.com.","type":"NS","ttl":21600,"rrdatas":["ns-cloud-b1.googledomains.com.","ns-cloud-b2.googledomains.com."],"signatureRrdatas":[],"kind":"dns#resourceRecordSet"},
 {"name":"example.com.","type":"SOA","ttl":21600,"rrdatas":["ns-cloud-b1.googledomains.com. cloud-dns-hostmaster.google.com. 1 21600 3600 259200 300"],"signatureRrdatas":[],"kind":"dns#resourceRecordSet"},
 {"name":"example.com.","type":"TXT","ttl":300,"rrdatas":["\"v=spf1 -all\"","\"part one \" \"two \\\"q\\\" \\195\\169\""],"signatureRrdatas":[],"kind":"dns#resourceRecordSet"}]}`,
		}),
		api("GET", "/managedZones/example-com/rrsets", dnstest.Exchange{
			Query: map[string]string{"pageToken": "page-2"},
			Response: rrsets(wwwA, cdnCNAME, geoA,
				`{"name":"*.example.com.","type":"A","ttl":60,"rrdatas":["192.0.2.9"],"signatureRrdatas":[],"kind":"dns#resourceRecordSet"}`),
		}),
	)
	records, err := provider(t, s, nil).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 9 {
		t.Fatalf("records: %+v", records)
	}
	for _, want := range [][3]string{
		{"@", "NS", "ns-cloud-b1.googledomains.com."}, {"@", "TXT", "v=spf1 -all"}, {"@", "TXT", `part one two "q" é`},
		{"www", "A", "192.0.2.2"}, {"cdn", "CNAME", "edge.example.net"}, {"*", "A", "192.0.2.9"},
	} {
		if !dnstest.Has(records, want[0], want[1], want[2]) {
			t.Errorf("missing %v in %+v", want, records)
		}
	}
	if dnstest.Has(records, "api", "A", "192.0.2.20") {
		t.Fatal("routing-policy record set listed")
	}
	if records[0].RR().TTL != 21600*time.Second {
		t.Fatalf("ttl %v", records[0].RR().TTL)
	}
}

func TestAppendRecordsExtendsTheRecordSet(t *testing.T) {
	s := dnstest.Serve(t,
		tokenCall(),
		zoneLookup(),
		lookup("_acme-challenge.example.com.", "TXT", acmeTXT),
		lookup("_acme-challenge.cdn.example.com.", "TXT"),
		changes(`{"deletions":[`+acmeTXT+`],"additions":[
 {"name":"_acme-challenge.example.com.","type":"TXT","ttl":120,"rrdatas":["\"old\"","\"new\""]},
 {"name":"_acme-challenge.cdn.example.com.","type":"TXT","ttl":60,"rrdatas":["\"fresh\""]}]}`),
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
	s := dnstest.Serve(t, tokenCall(), zoneLookup(), lookup("api.example.com.", "A", geoA))
	_, err := provider(t, s, nil).AppendRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("api", "192.0.2.22", 60)})
	if !errors.Is(err, dnsx.ErrUnsupported) {
		t.Fatalf("err %v", err)
	}
}

func TestSetRecordsReplacesTheRecordSet(t *testing.T) {
	same := `{"name":"same.example.com.","type":"A","ttl":60,"rrdatas":["192.0.2.30"],"kind":"dns#resourceRecordSet"}`
	s := dnstest.Serve(t,
		tokenCall(),
		api("GET", "/managedZones/example-com", dnstest.Exchange{
			Response: `{"name":"example-com","dnsName":"example.com.","description":"","id":"6151096870552453390","visibility":"public","kind":"dns#managedZone"}`,
		}),
		// 192.0.2.1 stays with a new TTL, 192.0.2.2 goes, 192.0.2.3 is added;
		// the TXT of the same name is another record set and stays.
		lookup("www.example.com.", "A", wwwA, wwwTXT),
		lookup("api.example.com.", "A", geoA),
		lookup("same.example.com.", "A", same),
		lookup("cdn.example.com.", "CNAME"),
		changes(`{"deletions":[`+wwwA+`,`+geoA+`],"additions":[
 {"name":"www.example.com.","type":"A","ttl":60,"rrdatas":["192.0.2.1","192.0.2.3"]},
 {"name":"api.example.com.","type":"A","ttl":60,"rrdatas":["192.0.2.7"]},
 {"name":"cdn.example.com.","type":"CNAME","ttl":300,"rrdatas":["edge.example.net."]}]}`),
	)
	out, err := provider(t, s, map[string]string{"managed_zone": "example-com"}).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60), dnstest.A("api", "192.0.2.7", 60),
		dnstest.A("same", "192.0.2.30", 60), dnstest.CNAME("cdn", "edge.example.net", 300),
	})
	if err != nil || len(out) != 5 {
		t.Fatalf("out %v err %v", out, err)
	}
}

func TestDeleteRecords(t *testing.T) {
	old := `{"name":"old.example.com.","type":"CNAME","ttl":300,"rrdatas":["gone.example.net."],"kind":"dns#resourceRecordSet"}`
	s := dnstest.Serve(t,
		tokenCall(),
		zoneLookup(),
		lookup("www.example.com.", "A", wwwA),
		lookup("_acme-challenge.example.com.", "TXT", acmeTXT),
		lookup("old.example.com.", "CNAME", old),
		lookup("none.example.com.", "A"),
		changes(`{"deletions":[`+wwwA+`,`+acmeTXT+`,`+old+`],"additions":[{"name":"www.example.com.","type":"A","ttl":600,"rrdatas":["192.0.2.1"]}]}`),
	)
	deleted, err := provider(t, s, nil).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.2", 600), dnstest.TXT("_acme-challenge", "old", 60),
		libdns.RR{Name: "old", Type: "CNAME"}, dnstest.A("none", "192.0.2.1", 60),
	})
	if err != nil || len(deleted) != 3 || !dnstest.Has(deleted, "www", "A", "192.0.2.2") || !dnstest.Has(deleted, "old", "CNAME", "gone.example.net") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZonesAndTokenRefresh(t *testing.T) {
	s := dnstest.Serve(t,
		tokenCall(),
		api("GET", "/managedZones", dnstest.Exchange{Query: map[string]string{"pageToken": "", "dnsName": ""},
			Response: `{"managedZones":[{"name":"a","dnsName":"Example.com.","visibility":"public"},{"name":"b","dnsName":"corp.example.com.","visibility":"private"}],"nextPageToken":"n2"}`}),
		api("GET", "/managedZones", dnstest.Exchange{Query: map[string]string{"pageToken": "n2"},
			Response: `{"managedZones":[{"name":"c","dnsName":"example.net.","visibility":"public"}]}`}),
		tokenCallAt(clock.Add(3540*time.Second)),
		api("GET", "/managedZones", dnstest.Exchange{Response: `{"managedZones":[]}`}),
	)
	p := provider(t, s, nil)
	zones, err := p.ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
	// The token (3599 s) is renewed a minute before it expires.
	p.now = func() time.Time { return clock.Add(3540 * time.Second) }
	if _, err := p.ListZones(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func errBody(code int, status, reason, message string) string {
	return fmt.Sprintf(`{"error":{"code":%d,"message":%q,"errors":[{"message":%q,"domain":"global","reason":%q}],"status":%q}}`,
		code, message, message, reason, status)
}

func TestErrors(t *testing.T) {
	ctx := context.Background()
	pemBody := strings.Split(keyPEM(testKey), "\n")[1]

	s := dnstest.Serve(t, dnstest.Exchange{Method: "POST", Path: "/token", Status: 400, Response: `{"error":"invalid_grant","error_description":"Invalid JWT Signature."}`})
	_, err := provider(t, s, nil).GetRecords(ctx, "example.com.")
	assertion, _ := url.ParseQuery(string(s.Requests[0].Body))
	dnstest.NoSecret(t, err, pemBody, assertion.Get("assertion"))
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("invalid grant: %v", err)
	}

	withAPI := func(status int, body string) error {
		s := dnstest.Serve(t, tokenCall(), api("GET", "/managedZones", dnstest.Exchange{Status: status, Response: body}))
		_, err := provider(t, s, nil).GetRecords(ctx, "example.com.")
		dnstest.NoSecret(t, err, accessToken, pemBody)
		return err
	}
	if err = withAPI(401, errBody(401, "UNAUTHENTICATED", "authError", "Request had invalid authentication credentials.")); dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("401: %v", err)
	}
	if err = withAPI(403, errBody(403, "PERMISSION_DENIED", "forbidden", "Forbidden")); dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("403: %v", err)
	}
	if err = withAPI(403, errBody(403, "PERMISSION_DENIED", "rateLimitExceeded", "Rate Limit Exceeded")); !errors.Is(err, dnsx.ErrRateLimited) {
		t.Fatalf("rate limit: %v", err)
	}
	if err = withAPI(502, `<html>Bad Gateway</html>`); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	if err = withAPI(200, `{"managedZones":[{"name":"other","dnsName":"example.org.","visibility":"public"}]}`); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("no zone: %v", err)
	}
	if err = withAPI(200, `{"managedZones":[{"name":"one","dnsName":"example.com.","visibility":"public"},{"name":"two","dnsName":"example.com.","visibility":"public"}]}`); !errors.Is(err, dnsx.ErrInvalid) {
		t.Fatalf("ambiguous zone: %v", err)
	}

	s = dnstest.Serve(t, tokenCall(), api("GET", "/managedZones/nope", dnstest.Exchange{Status: 404,
		Response: errBody(404, "NOT_FOUND", "notFound", "The 'parameters.managedZone' resource named 'nope' does not exist.")}))
	if _, err = provider(t, s, map[string]string{"managed_zone": "nope"}).GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown managed zone: %v", err)
	}
	s = dnstest.Serve(t, tokenCall(), api("GET", "/managedZones/example-org", dnstest.Exchange{Response: `{"name":"example-org","dnsName":"example.org.","visibility":"public"}`}))
	if _, err = provider(t, s, map[string]string{"managed_zone": "example-org"}).GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("managed zone of another name: %v", err)
	}

	s = dnstest.Serve(t, tokenCall(), zoneLookup(), lookup("www.example.com.", "A", wwwA), api("POST", "/managedZones/example-com/changes", dnstest.Exchange{Status: 412,
		Response: errBody(412, "FAILED_PRECONDITION", "conditionNotMet", "Precondition not met for 'entity.change.deletions[0]'")}))
	_, err = provider(t, s, nil).SetRecords(ctx, "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.9", 60)})
	if dnsx.Code(err) != "dns_provider_error" || !strings.Contains(err.Error(), "conditionNotMet") {
		t.Fatalf("conflict: %v", err)
	}

	for _, fields := range []map[string]string{
		{"service_account_json": "not json"},
		{"service_account_json": keyFile(func(f map[string]string) { f["type"] = "authorized_user" })},
		{"service_account_json": keyFile(func(f map[string]string) {
			f["private_key"] = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"
		})},
		{"service_account_json": keyFile(func(f map[string]string) { f["private_key"] = keyPEM(generate(1024)) })},
		{"service_account_json": keyFile(func(f map[string]string) { f["client_email"] = "" })},
		{"service_account_json": keyFile(func(f map[string]string) { f["universe_domain"] = "example.org" })},
		{"service_account_json": keyFile(func(f map[string]string) { f["project_id"] = "" })},
		{"service_account_json": keyFile(nil), "project_id": "../other"},
		{"service_account_json": keyFile(nil), "managed_zone": "zone/../../x"},
	} {
		_, err := New(fields, dnsx.Options{})
		if !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed credentials accepted: %v", err)
		}
		dnstest.NoSecret(t, err, pemBody)
	}
}

func TestTXTQuoting(t *testing.T) {
	long := strings.Repeat("a", 300)
	quoted := quoteTXT(long + `"\` + "\x01")
	if quoted != `"`+strings.Repeat("a", 255)+`" "`+strings.Repeat("a", 45)+`\"\\\001"` {
		t.Fatalf("quoted %s", quoted)
	}
	if unquoteTXT(quoted) != long+`"\`+"\x01" || unquoteTXT("plain") != "plain" || quoteTXT("") != `""` {
		t.Fatal("unquote")
	}
}
