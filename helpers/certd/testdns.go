package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/libdns/libdns"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// testDNSProvider is only reachable with an operator-supplied fixture URL.
// The API cannot choose that URL or redirect real provider credentials to it.
type testDNSProvider struct {
	APIToken string `json:"api_token"`
}

func (p *testDNSProvider) call(ctx context.Context, action, zone string, records []libdns.Record) ([]libdns.Record, error) {
	endpoint := os.Getenv("EDGEWEIR_DNS_TEST_ENDPOINT")
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("DNS fixture is disabled")
	}
	input := struct {
		Zone    string      `json:"zone"`
		Records []dnsRecord `json:"records"`
	}{Zone: strings.TrimSuffix(zone, ".")}
	for _, record := range records {
		rr := record.RR()
		input.Records = append(input.Records, dnsRecord{Name: rr.Name, Type: rr.Type, Data: rr.Data, TTL: int(rr.TTL / time.Second)})
	}
	raw, _ := json.Marshal(input)
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(endpoint, "/")+"/dns/"+action, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIToken)
	response, err := (&http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("DNS fixture transport failed")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("DNS fixture request failed")
	}
	var result []dnsRecord
	if err := json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(&result); err != nil {
		return nil, err
	}
	out := make([]libdns.Record, 0, len(result))
	for _, r := range result {
		out = append(out, libdns.RR{Name: r.Name, Type: r.Type, Data: r.Data, TTL: time.Duration(r.TTL) * time.Second})
	}
	return out, nil
}
func (p *testDNSProvider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	return p.call(ctx, "list", zone, nil)
}
func (p *testDNSProvider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	return p.call(ctx, "append", zone, records)
}
func (p *testDNSProvider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	return p.call(ctx, "set", zone, records)
}
func (p *testDNSProvider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	return p.call(ctx, "delete", zone, records)
}
