package fixture

import (
	"context"
	"errors"
	"testing"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

func TestFixtureNeedsTheOperatorEndpoint(t *testing.T) {
	t.Setenv("EDGEWEIR_DNS_TEST_ENDPOINT", "")
	if _, err := New(map[string]string{"api_token": "t"}, dnsx.Options{}); !errors.Is(err, dnsx.ErrUnsupported) {
		t.Fatalf("fixture without endpoint: %v", err)
	}
}

func TestFixtureOperations(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "POST", Path: "/dns/list", Header: map[string]string{"Authorization": "Bearer e2e"}, JSON: map[string]any{"zone": "example.test"}, Response: `[{"name":"www","type":"A","data":"192.0.2.1","ttl":60}]`},
		dnstest.Exchange{Method: "POST", Path: "/dns/set", JSON: map[string]any{"zone": "example.test", "records": []any{map[string]any{"name": "www", "type": "A", "data": "192.0.2.2", "ttl": 60}}}, Response: `[]`},
		dnstest.Exchange{Method: "POST", Path: "/dns/append", Response: `[]`},
		dnstest.Exchange{Method: "POST", Path: "/dns/delete", Response: `[]`},
		dnstest.Exchange{Method: "POST", Path: "/dns/zones", Response: `["example.test","Other.test."]`},
		dnstest.Exchange{Method: "POST", Path: "/dns/list", Status: 401, Response: `{"error":"invalid fixture token"}`},
	)
	t.Setenv("EDGEWEIR_DNS_TEST_ENDPOINT", s.URL)
	p, err := New(map[string]string{"api_token": "e2e"}, dnsx.Options{HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	records, err := p.GetRecords(ctx, "example.test.")
	if err != nil || !dnstest.Has(records, "www", "A", "192.0.2.1") {
		t.Fatalf("list: %v %v", records, err)
	}
	if _, err := p.SetRecords(ctx, "example.test.", []libdns.Record{dnstest.A("www", "192.0.2.2", 60)}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.AppendRecords(ctx, "example.test.", []libdns.Record{dnstest.TXT("_x", "y", 60)}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DeleteRecords(ctx, "example.test.", []libdns.Record{dnstest.TXT("_x", "y", 60)}); err != nil {
		t.Fatal(err)
	}
	zones, err := p.(*Provider).ListZones(ctx)
	if err != nil || len(zones) != 2 || zones[1].Name != "other.test." {
		t.Fatalf("zones: %v %v", zones, err)
	}
	_, err = p.GetRecords(ctx, "example.test.")
	dnstest.NoSecret(t, err, "e2e")
	if dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("401: %v", err)
	}
}

func TestFixturePassesLines(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "POST", Path: "/dns/list",
			Response: `[{"name":"all","type":"A","data":"192.0.2.1","ttl":60,"line":"default"},{"name":"all","type":"A","data":"192.0.2.2","ttl":60,"line":"telecom"},{"name":"www","type":"A","data":"192.0.2.3","ttl":60}]`},
		dnstest.Exchange{Method: "POST", Path: "/dns/set", Body: `{"zone":"example.test","records":[{"name":"all","type":"A","data":"192.0.2.1","ttl":60},{"name":"all","type":"A","data":"192.0.2.4","ttl":60,"line":"unicom"}]}`, Response: `[]`},
	)
	t.Setenv("EDGEWEIR_DNS_TEST_ENDPOINT", s.URL)
	p, err := New(map[string]string{"api_token": "e2e"}, dnsx.Options{HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	records, err := p.GetRecords(ctx, "example.test.")
	if err != nil || len(records) != 3 || dnsx.LineOf(records[0]) != "" || dnsx.LineOf(records[1]) != "telecom" || dnsx.LineOf(records[2]) != "" {
		t.Fatalf("list: %v %v", records, err)
	}
	if _, err := p.SetRecords(ctx, "example.test.", []libdns.Record{
		dnstest.A("all", "192.0.2.1", 60), dnsx.OnLine(dnstest.A("all", "192.0.2.4", 60).RR(), "unicom"),
	}); err != nil {
		t.Fatal(err)
	}
}
