// Package fixture is the local test DNS provider used by end-to-end tests.
// It is only reachable when the operator sets EDGEWEIR_DNS_TEST_ENDPOINT for
// the helper; the API cannot choose that URL or send real provider
// credentials to it.
package fixture

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// Provider posts every operation to <endpoint>/dns/<action>.
type Provider struct {
	token    string
	endpoint string
	client   *http.Client
}

// New builds the adapter from the catalog fields (api_token).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	endpoint := os.Getenv("EDGEWEIR_DNS_TEST_ENDPOINT")
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("%w: DNS fixture is disabled", dnsx.ErrUnsupported)
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	return &Provider{token: fields["api_token"], endpoint: strings.TrimRight(endpoint, "/"), client: client}, nil
}

type record struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Data string `json:"data"`
	TTL  int    `json:"ttl"`
}

func (p *Provider) call(ctx context.Context, action, zone string, records []libdns.Record, out any) error {
	input := struct {
		Zone    string   `json:"zone"`
		Records []record `json:"records"`
	}{Zone: dnsx.Zone(zone)}
	for _, r := range dnsx.RRs(records) {
		input.Records = append(input.Records, record{Name: r.Name, Type: r.Type, Data: r.Data, TTL: dnsx.Seconds(r.TTL)})
	}
	raw, _ := json.Marshal(input)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint+"/dns/"+action, bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.token)
	status, body, err := dnsx.Do(p.client, req)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return &dnsx.StatusError{Status: status}
	}
	if json.Unmarshal(body, out) != nil {
		return fmt.Errorf("%w: invalid fixture response", dnsx.ErrProvider)
	}
	return nil
}

func (p *Provider) records(ctx context.Context, action, zone string, records []libdns.Record) ([]libdns.Record, error) {
	var result []record
	if err := p.call(ctx, action, zone, records, &result); err != nil {
		return nil, err
	}
	out := make([]libdns.Record, 0, len(result))
	for _, r := range result {
		out = append(out, dnsx.RR(r.Name, r.Type, r.Data, r.TTL))
	}
	return out, nil
}

// GetRecords lists the zone.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	return p.records(ctx, "list", zone, nil)
}

// AppendRecords adds records.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	return p.records(ctx, "append", zone, records)
}

// SetRecords replaces the input RRsets.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	return p.records(ctx, "set", zone, records)
}

// DeleteRecords removes matching records.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	return p.records(ctx, "delete", zone, records)
}

// ListZones lists the zones the fixture token owns.
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var zones []string
	if err := p.call(ctx, "zones", "", nil, &zones); err != nil {
		return nil, err
	}
	out := make([]libdns.Zone, 0, len(zones))
	for _, z := range zones {
		out = append(out, libdns.Zone{Name: dnsx.Zone(z) + "."})
	}
	return out, nil
}
