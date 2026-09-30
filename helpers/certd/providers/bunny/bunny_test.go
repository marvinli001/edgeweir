package bunny

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Bodies follow the bunny.net API reference (OpenAPI
// https://core-api-public-docs.b-cdn.net/docs/v3/public.json, pages under
// https://docs.bunny.net/api-reference/core/dns-zone: List DNS Zones, List
// DNS Zone Records, Add/Update/Delete DNS Record; errors are ApiErrorData).
const key = "0f6e2c1a-8d3b-4e5f-9a7b-1c2d3e4f5a6b7c8d9e0f-1a2b-3c4d-5e6f-7a8b9c0d1e2f"

var headers = map[string]string{"AccessKey": key, "User-Agent": "edgeweir-certd/1", "Accept": "application/json"}

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	p, err := New(map[string]string{"access_key": key}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return p.(*Provider)
}

// zoneCall answers the zone lookup; the search also returns a sub-zone.
var zoneCall = dnstest.Exchange{
	Method: "GET", Path: "/dnszone", Header: headers,
	Query:    map[string]string{"search": "example.com", "page": "1", "perPage": "1000", "view": "1"},
	Response: `{"Items":[{"Id":11,"Domain":"sub.example.com","DnsSecEnabled":false},{"Id":12,"Domain":"example.com","DnsSecEnabled":false}],"CurrentPage":1,"TotalItems":2,"HasMoreItems":false}`,
}

func rec(id, typ, ttl, name, value string) string {
	return `{"Id":` + id + `,"Type":` + typ + `,"Ttl":` + ttl + `,"Value":"` + value + `","Name":"` + name +
		`","Weight":100,"Priority":0,"Port":0,"Flags":0,"Tag":null,"Accelerated":false,"MonitorStatus":0,"MonitorType":0,"SmartRoutingType":0,"Disabled":false,"Comment":null}`
}

func listCall(page, more string, records ...string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "GET", Path: "/dnszone/12/records", Header: headers,
		Query:    map[string]string{"page": page, "perPage": "1000"},
		Response: `{"Items":[` + strings.Join(records, ",") + `],"CurrentPage":` + page + `,"TotalItems":6,"HasMoreItems":` + more + `}`,
	}
}

var existing = []string{
	rec("1", "0", "300", "www", "192.0.2.1"),
	rec("2", "0", "300", "www", "192.0.2.2"),
	rec("3", "3", "3600", "", "keep"),
	rec("4", "2", "60", "cdn", "edge.example.net"),
	`{"Id":5,"Type":4,"Ttl":3600,"Value":"mail.example.com","Name":"","Priority":10}`,
}

func TestGetRecordsPages(t *testing.T) {
	s := dnstest.Serve(t,
		zoneCall,
		listCall("1", "true", existing[:3]...),
		listCall("2", "false", existing[3:]...),
	)
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 5 || !dnstest.Has(records, "www", "A", "192.0.2.2") || !dnstest.Has(records, "@", "TXT", "keep") ||
		!dnstest.Has(records, "cdn", "CNAME", "edge.example.net") || !dnstest.Has(records, "@", "MX", "10 mail.example.com") {
		t.Fatalf("records: %+v", records)
	}
	if ttl := records[0].RR().TTL.Seconds(); ttl != 300 {
		t.Fatalf("ttl %v", ttl)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t,
		zoneCall,
		dnstest.Exchange{Method: "PUT", Path: "/dnszone/12/records", Header: map[string]string{"AccessKey": key, "Content-Type": "application/json"},
			JSON:   map[string]any{"Type": 3, "Ttl": 60, "Value": "token-value", "Name": "_acme-challenge"},
			Status: 201, Response: rec("20", "3", "60", "_acme-challenge", "token-value")},
		// CNAME at the apex (Bunny flattens it).
		dnstest.Exchange{Method: "PUT", Path: "/dnszone/12/records",
			JSON:   map[string]any{"Type": 2, "Ttl": 300, "Value": "edge.example.net", "Name": ""},
			Status: 201, Response: rec("21", "2", "300", "", "edge.example.net")},
	)
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", "token-value", 60), dnstest.CNAME("@", "edge.example.net", 300),
	})
	if err != nil || len(done) != 2 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsReplacesTheRRset(t *testing.T) {
	s := dnstest.Serve(t,
		zoneCall,
		listCall("1", "false", existing...),
		// 192.0.2.1 stays with a new TTL, 192.0.2.2 goes, 192.0.2.3 is created;
		// the other RRsets are untouched.
		dnstest.Exchange{Method: "POST", Path: "/dnszone/12/records/1", Header: headers,
			JSON: map[string]any{"Type": 0, "Ttl": 60, "Value": "192.0.2.1", "Name": "www"}, Status: 204},
		dnstest.Exchange{Method: "DELETE", Path: "/dnszone/12/records/2", Header: headers, Status: 204},
		dnstest.Exchange{Method: "PUT", Path: "/dnszone/12/records",
			JSON: map[string]any{"Type": 0, "Ttl": 60, "Value": "192.0.2.3", "Name": "www"}, Status: 201, Response: rec("22", "0", "60", "www", "192.0.2.3")},
	)
	set, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60),
	})
	if err != nil || len(set) != 2 {
		t.Fatalf("set %v err %v", set, err)
	}
}

func TestDeleteRecords(t *testing.T) {
	s := dnstest.Serve(t,
		zoneCall,
		listCall("1", "false", existing...),
		dnstest.Exchange{Method: "DELETE", Path: "/dnszone/12/records/1", Status: 204},
		dnstest.Exchange{Method: "DELETE", Path: "/dnszone/12/records/2", Status: 204},
		dnstest.Exchange{Method: "DELETE", Path: "/dnszone/12/records/4", Status: 204},
	)
	// The whole www A RRset (no data), the CNAME by data with a trailing dot,
	// and a record that does not exist.
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		libdns.RR{Name: "www", Type: "A"}, dnstest.CNAME("cdn", "edge.example.net.", 0), dnstest.TXT("@", "missing", 0),
	})
	if err != nil || len(deleted) != 3 || !dnstest.Has(deleted, "www", "A", "192.0.2.1") {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/dnszone", Header: headers, Query: map[string]string{"page": "1", "perPage": "1000", "view": "1", "search": ""},
			Response: `{"Items":[{"Id":12,"Domain":"example.com"}],"CurrentPage":1,"TotalItems":2,"HasMoreItems":true}`},
		dnstest.Exchange{Method: "GET", Path: "/dnszone", Query: map[string]string{"page": "2"},
			Response: `{"Items":[{"Id":13,"Domain":"Example.NET"}],"CurrentPage":2,"TotalItems":2,"HasMoreItems":false}`},
	)
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "GET", Path: "/dnszone", Status: 401, Response: ``},
		dnstest.Exchange{Method: "GET", Path: "/dnszone", Response: `{"Items":[{"Id":11,"Domain":"sub.example.com"}],"CurrentPage":1,"TotalItems":1,"HasMoreItems":false}`},
		dnstest.Exchange{Method: "GET", Path: "/dnszone", Status: 500, Response: ``},
		zoneCall,
		dnstest.Exchange{Method: "PUT", Path: "/dnszone/12/records", Status: 400,
			Response: `{"ErrorKey":"dnszone.record.invalid_value","Field":"Value","Message":"The record value is invalid."}`},
	)
	p := provider(t, s)
	_, err := p.GetRecords(context.Background(), "example.com.")
	dnstest.NoSecret(t, err, key)
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("bad key: %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	_, err = p.AppendRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.300", 60)})
	if dnsx.Code(err) != "dns_provider_error" || !strings.Contains(err.Error(), "The record value is invalid.") {
		t.Fatalf("validation: %v", err)
	}
	for _, bad := range []string{"", "short", "key with spaces-1234567890", strings.Repeat("a", 129)} {
		if _, err := New(map[string]string{"access_key": bad}, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed key %q accepted: %v", bad, err)
		}
	}
	if _, err := p.SetRecords(context.Background(), "example.com.", []libdns.Record{libdns.RR{Name: "@", Type: "MX", Data: "10 mail.example.com"}}); !errors.Is(err, dnsx.ErrUnsupported) {
		t.Fatalf("MX write: %v", err)
	}
}
