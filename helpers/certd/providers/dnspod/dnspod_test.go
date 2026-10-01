package dnspod

import (
	"context"
	"errors"
	"testing"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Responses follow the examples of the DNSPod API reference
// (https://docs.dnspod.cn/api/: Record.List, Record.Create, Record.Modify,
// Record.Remove, Domain.List, 共通返回).
const token = "12345,0123456789abcdef0123456789abcdef"

func provider(t *testing.T, s *dnstest.Server) *Provider {
	t.Helper()
	p, err := New(map[string]string{"auth_token": token}, dnsx.Options{BaseURL: s.URL, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return p.(*Provider)
}

func listCall(records string) dnstest.Exchange {
	return dnstest.Exchange{
		Method: "POST", Path: "/Record.List",
		Header:   map[string]string{"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "*"},
		Form:     map[string]string{"login_token": token, "format": "json", "error_on_empty": "no", "domain": "example.com", "offset": "0", "length": "3000"},
		Response: `{"status":{"code":"1","message":"Action completed successful"},"domain":{"id":"1","name":"example.com"},"records":[` + records + `]}`,
	}
}

const existing = `{"id":"10","name":"www","line":"Default","type":"A","ttl":"600","value":"192.0.2.1","enabled":"1"},
{"id":"11","name":"www","line":"Default","type":"A","ttl":"600","value":"192.0.2.2","enabled":"1"},
{"id":"12","name":"@","line":"Default","type":"TXT","ttl":"600","value":"keep","enabled":"1"}`

func TestGetRecords(t *testing.T) {
	s := dnstest.Serve(t, listCall(existing))
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 3 || !dnstest.Has(records, "www", "A", "192.0.2.1") || !dnstest.Has(records, "@", "TXT", "keep") {
		t.Fatalf("records: %+v", records)
	}
	if records[0].RR().TTL.Seconds() != 600 {
		t.Fatalf("ttl: %v", records[0].RR().TTL)
	}
}

func TestGetRecordsEmptyZone(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{Method: "POST", Path: "/Record.List", Response: `{"status":{"code":"10","message":"No records"}}`})
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil || len(records) != 0 {
		t.Fatalf("records %v err %v", records, err)
	}
}

func TestAppendRecords(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{
		Method: "POST", Path: "/Record.Create",
		Form:     map[string]string{"login_token": token, "domain": "example.com", "sub_domain": "all.cdn", "record_type": "A", "record_line_id": "0", "value": "192.0.2.7", "ttl": "60"},
		Response: `{"status":{"code":"1","message":"Action completed successful"},"record":{"id":"20","name":"all.cdn","status":"enabled"}}`,
	})
	done, err := provider(t, s).AppendRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("all.cdn", "192.0.2.7", 60)})
	if err != nil || len(done) != 1 {
		t.Fatalf("done %v err %v", done, err)
	}
}

func TestSetRecordsReplacesTheRRset(t *testing.T) {
	s := dnstest.Serve(t,
		listCall(existing),
		// 192.0.2.1 stays with a new TTL, 192.0.2.2 goes, 192.0.2.3 is created; the TXT is untouched.
		dnstest.Exchange{Method: "POST", Path: "/Record.Modify", Form: map[string]string{"record_id": "10", "sub_domain": "www", "record_type": "A", "value": "192.0.2.1", "ttl": "60", "record_line_id": "0"}, Response: `{"status":{"code":"1"}}`},
		dnstest.Exchange{Method: "POST", Path: "/Record.Remove", Form: map[string]string{"record_id": "11", "domain": "example.com"}, Response: `{"status":{"code":"1"}}`},
		dnstest.Exchange{Method: "POST", Path: "/Record.Create", Form: map[string]string{"sub_domain": "www", "value": "192.0.2.3", "ttl": "60"}, Response: `{"status":{"code":"1"}}`},
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
		listCall(existing),
		dnstest.Exchange{Method: "POST", Path: "/Record.Remove", Form: map[string]string{"record_id": "11"}, Response: `{"status":{"code":"1"}}`},
	)
	deleted, err := provider(t, s).DeleteRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.2", 60)})
	if err != nil || len(deleted) != 1 {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
}

func TestListZones(t *testing.T) {
	s := dnstest.Serve(t, dnstest.Exchange{
		Method: "POST", Path: "/Domain.List", Form: map[string]string{"type": "all", "offset": "0", "length": "3000"},
		Response: `{"status":{"code":"1"},"info":{"domain_total":2},"domains":[{"id":1,"name":"example.com"},{"id":2,"name":"Example.NET"}]}`,
	})
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "example.com." || zones[1].Name != "example.net." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestErrors(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{Method: "POST", Path: "/Record.List", Response: `{"status":{"code":"-1","message":"Login failed"}}`},
		dnstest.Exchange{Method: "POST", Path: "/Record.List", Response: `{"status":{"code":"6","message":"Domain id invalid"}}`},
		dnstest.Exchange{Method: "POST", Path: "/Record.List", Status: 502, Response: `bad gateway`},
	)
	p := provider(t, s)
	_, err := p.GetRecords(context.Background(), "example.com.")
	dnstest.NoSecret(t, err, token, "0123456789abcdef")
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" {
		t.Fatalf("login failure: %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "example.com."); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "example.com."); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("5xx: %v", err)
	}
	if _, err := New(map[string]string{"auth_token": "no-comma"}, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
		t.Fatalf("malformed token accepted: %v", err)
	}
}

func TestGetRecordsPaginates(t *testing.T) {
	page := func(offset, records string) dnstest.Exchange {
		return dnstest.Exchange{
			Method: "POST", Path: "/Record.List", Form: map[string]string{"domain": "example.com", "offset": offset, "length": "3000"},
			Response: `{"status":{"code":"1","message":"Action completed successful"},"domain":{"id":"12600793","name":"example.com"},` +
				`"info":{"sub_domains":"7","record_total":"3","records_num":"2"},"records":[` + records + `]}`,
		}
	}
	s := dnstest.Serve(t,
		// The service may return fewer records than asked for: the next page starts after them.
		page("0", `{"id":"13608148","name":"www","line":"电信","line_id":"10=0","type":"A","ttl":"600","value":"192.0.2.3","enabled":"1"},
{"id":"13608149","name":"www","line":"默认","line_id":"0","type":"A","ttl":"600","value":"192.0.2.4","enabled":"1"}`),
		page("2", `{"id":"13608150","name":"@","line":"默认","line_id":"0","type":"NS","ttl":"86400","value":"ns3.dnsv5.com.","enabled":"1"}`),
	)
	records, err := provider(t, s).GetRecords(context.Background(), "example.com.")
	if err != nil || len(records) != 3 || !dnstest.Has(records, "@", "NS", "ns3.dnsv5.com.") {
		t.Fatalf("records %v err %v", records, err)
	}
}

func TestSetRecordsKeepsOnlyTheDefaultLine(t *testing.T) {
	s := dnstest.Serve(t,
		listCall(`{"id":"20","name":"www","line":"电信","line_id":"10=0","type":"A","ttl":"600","value":"192.0.2.1","enabled":"1"},
{"id":"21","name":"www","line":"默认","line_id":"0","type":"A","ttl":"600","value":"192.0.2.1","enabled":"1"}`),
		// The telecom-line copy goes; the default-line record already matches.
		dnstest.Exchange{Method: "POST", Path: "/Record.Remove", Form: map[string]string{"record_id": "20"}, Response: `{"status":{"code":"1"}}`},
	)
	if _, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.1", 600)}); err != nil {
		t.Fatal(err)
	}
}

func TestSetRecordsCreatesTheDefaultLine(t *testing.T) {
	s := dnstest.Serve(t,
		listCall(`{"id":"20","name":"www","line":"联通","line_id":"10=1","type":"A","ttl":"600","value":"192.0.2.1","enabled":"1"}`),
		dnstest.Exchange{Method: "POST", Path: "/Record.Remove", Form: map[string]string{"record_id": "20"}, Response: `{"status":{"code":"1"}}`},
		dnstest.Exchange{Method: "POST", Path: "/Record.Create", Form: map[string]string{"sub_domain": "www", "record_line_id": "0", "value": "192.0.2.1"}, Response: `{"status":{"code":"1"}}`},
	)
	if _, err := provider(t, s).SetRecords(context.Background(), "example.com.", []libdns.Record{dnstest.A("www", "192.0.2.1", 600)}); err != nil {
		t.Fatal(err)
	}
}

func TestListZonesPunycodeAndPages(t *testing.T) {
	s := dnstest.Serve(t,
		dnstest.Exchange{
			Method: "POST", Path: "/Domain.List", Form: map[string]string{"type": "all", "offset": "0", "length": "3000", "error_on_empty": "no"},
			Response: `{"status":{"code":"1"},"info":{"domain_total":2,"all_total":2},"domains":[{"id":2238269,"status":"enable","grade":"D_Free","punycode":"xn--vnqp08b.cn","name":"我们.cn"}]}`,
		},
		dnstest.Exchange{
			Method: "POST", Path: "/Domain.List", Form: map[string]string{"offset": "1"},
			Response: `{"status":{"code":"1"},"info":{"domain_total":2,"all_total":2},"domains":[{"id":10360095,"status":"enable","grade":"DP_Free","punycode":"usertest.com","name":"usertest.com"}]}`,
		},
	)
	zones, err := provider(t, s).ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "xn--vnqp08b.cn." || zones[1].Name != "usertest.com." {
		t.Fatalf("zones %v err %v", zones, err)
	}
}

func TestStatusCodes(t *testing.T) {
	answer := func(path, code string) dnstest.Exchange {
		return dnstest.Exchange{Method: "POST", Path: path, Response: `{"status":{"code":"` + code + `","message":"message"}}`}
	}
	s := dnstest.Serve(t,
		answer("/Record.List", "-2"),
		answer("/Record.List", "-7"),
		answer("/Record.List", "83"),
		answer("/Record.List", "7"),
		answer("/Record.List", "8"),
		answer("/Domain.List", "7"),
		answer("/Record.List", "-99"),
	)
	p := provider(t, s)
	ctx := context.Background()
	for _, want := range []error{dnsx.ErrRateLimited, dnsx.ErrAuth, dnsx.ErrAuth, dnsx.ErrZoneNotFound, dnsx.ErrZoneNotFound} {
		if _, err := p.GetRecords(ctx, "example.com."); !errors.Is(err, want) {
			t.Fatalf("got %v, want %v", err, want)
		}
	}
	if _, err := p.ListZones(ctx); dnsx.Code(err) != "dns_provider_error" {
		t.Fatalf("Domain.List paging error: %v", err)
	}
	if _, err := p.GetRecords(ctx, "example.com."); dnsx.Code(err) != "dns_provider_error" {
		t.Fatalf("feature paused: %v", err)
	}
	for _, bad := range []string{"12345, 0123456789abcdef", "abc,0123456789abcdef", "12345,", "12345,0123456789abcdef\n"} {
		if _, err := New(map[string]string{"auth_token": bad}, dnsx.Options{}); !errors.Is(err, dnsx.ErrInvalid) {
			t.Fatalf("malformed token %q accepted: %v", bad, err)
		}
	}
}
