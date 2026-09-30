// Package dnspod is the DNSPod adapter for the classic token API
// (https://docs.dnspod.cn/api/): form-encoded POSTs authenticated with a
// login_token "ID,Token". The published libdns module predates libdns v1.
package dnspod

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const endpoint = "https://dnsapi.cn"

// Provider talks to one DNSPod account.
type Provider struct {
	Token   string
	BaseURL string
	Client  *http.Client
	mu      sync.Mutex // DNSPod applies changes per record; serialize writes per provider.
}

// New builds the adapter from the catalog fields (auth_token).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	token := fields["auth_token"]
	if token == "" || !strings.Contains(token, ",") {
		return nil, fmt.Errorf("%w: DNSPod auth_token must be \"ID,Token\"", dnsx.ErrInvalid)
	}
	return &Provider{Token: token, BaseURL: opts.Endpoint(endpoint), Client: opts.Client()}, nil
}

type status struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type record struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value string `json:"value"`
	TTL   string `json:"ttl"`
}
type response struct {
	Status  status   `json:"status"`
	Records []record `json:"records"`
	Domains []struct {
		Name string `json:"name"`
	} `json:"domains"`
}

func (p *Provider) call(ctx context.Context, action string, fields url.Values, ok ...string) (*response, error) {
	fields.Set("login_token", p.Token)
	fields.Set("format", "json")
	fields.Set("lang", "en")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.BaseURL+"/"+action, strings.NewReader(fields.Encode()))
	if err != nil {
		return nil, fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "edgeweir-certd/1 (DNS records)")
	statusCode, body, err := dnsx.Do(p.Client, req)
	if err != nil {
		return nil, err
	}
	if statusCode != http.StatusOK {
		return nil, &dnsx.StatusError{Status: statusCode}
	}
	var out response
	if json.Unmarshal(body, &out) != nil {
		return nil, fmt.Errorf("%w: invalid DNSPod response", dnsx.ErrProvider)
	}
	if out.Status.Code == "1" {
		return &out, nil
	}
	for _, code := range ok {
		if out.Status.Code == code {
			return &out, nil
		}
	}
	return nil, apiError(action, out.Status)
}

// apiError maps DNSPod status codes (docs "公共返回码" and per-action codes).
func apiError(action string, s status) error {
	kind := dnsx.ErrProvider
	switch s.Code {
	case "-1", "-8", "85":
		kind = dnsx.ErrAuth // login failed, too many failures, remote login refused
	case "-2":
		kind = dnsx.ErrRateLimited
	case "-7":
		kind = dnsx.ErrAuth // no permission for this API
	case "6", "9":
		kind = dnsx.ErrZoneNotFound // invalid domain, not the domain owner
	}
	return fmt.Errorf("%w: DNSPod %s status %s %s", kind, action, s.Code, dnsx.Short(s.Message))
}

func (p *Provider) list(ctx context.Context, zone string) ([]record, error) {
	var all []record
	for offset := 0; offset < 100000; offset += 3000 {
		res, err := p.call(ctx, "Record.List", url.Values{
			"domain": {dnsx.Zone(zone)}, "offset": {strconv.Itoa(offset)}, "length": {"3000"},
		}, "10") // 10: the zone has no records
		if err != nil {
			return nil, err
		}
		all = append(all, res.Records...)
		if len(res.Records) < 3000 {
			return all, nil
		}
	}
	return nil, fmt.Errorf("%w: DNSPod zone exceeds 100000 records", dnsx.ErrProvider)
}

func toRR(r record) libdns.RR {
	ttl, _ := strconv.Atoi(r.TTL)
	return dnsx.RR(r.Name, r.Type, r.Value, ttl)
}

// GetRecords lists every record of the zone.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	all, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	out := make([]libdns.Record, 0, len(all))
	for _, r := range all {
		out = append(out, toRR(r))
	}
	return out, nil
}

func (p *Provider) create(ctx context.Context, zone string, r libdns.RR) error {
	_, err := p.call(ctx, "Record.Create", url.Values{
		"domain": {dnsx.Zone(zone)}, "sub_domain": {r.Name}, "record_type": {r.Type},
		"record_line_id": {"0"}, "value": {r.Data}, "ttl": {strconv.Itoa(dnsx.Seconds(r.TTL))},
	})
	return err
}

func (p *Provider) remove(ctx context.Context, zone string, id string) error {
	_, err := p.call(ctx, "Record.Remove", url.Values{"domain": {dnsx.Zone(zone)}, "record_id": {id}})
	return err
}

// AppendRecords creates the records.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var done []libdns.Record
	for _, r := range dnsx.RRs(records) {
		if err := p.create(ctx, zone, r); err != nil {
			return done, err
		}
		done = append(done, r)
	}
	return done, nil
}

// SetRecords makes each input RRset exactly the input records: members that
// already exist are kept (TTL changes are rewritten), others are removed or
// created.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	existing, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	input := dnsx.RRs(records)
	sets := map[string]bool{}
	wanted := map[string]libdns.RR{}
	for _, r := range input {
		sets[dnsx.SetKey(r)] = true
		wanted[dnsx.Key(r)] = r
	}
	kept := map[string]bool{}
	for _, old := range existing {
		rr := toRR(old)
		if !sets[dnsx.SetKey(rr)] {
			continue
		}
		want, keep := wanted[dnsx.Key(rr)]
		if keep && !kept[dnsx.Key(rr)] {
			kept[dnsx.Key(rr)] = true
			if dnsx.Seconds(want.TTL) != dnsx.Seconds(rr.TTL) {
				if _, err := p.call(ctx, "Record.Modify", url.Values{
					"domain": {dnsx.Zone(zone)}, "record_id": {old.ID}, "sub_domain": {want.Name}, "record_type": {want.Type},
					"record_line_id": {"0"}, "value": {want.Data}, "ttl": {strconv.Itoa(dnsx.Seconds(want.TTL))},
				}); err != nil {
					return nil, err
				}
			}
			continue
		}
		if err := p.remove(ctx, zone, old.ID); err != nil {
			return nil, err
		}
	}
	for _, r := range input {
		if kept[dnsx.Key(r)] {
			continue
		}
		kept[dnsx.Key(r)] = true
		if err := p.create(ctx, zone, r); err != nil {
			return nil, err
		}
	}
	return records, nil
}

// DeleteRecords removes the matching records (data empty: the whole RRset).
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	existing, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	var deleted []libdns.Record
	for _, old := range existing {
		rr := toRR(old)
		for _, in := range dnsx.RRs(records) {
			if dnsx.Matches(rr, in) {
				if err := p.remove(ctx, zone, old.ID); err != nil {
					return deleted, err
				}
				deleted = append(deleted, rr)
				break
			}
		}
	}
	return deleted, nil
}

// ListZones lists the account's domains.
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var zones []libdns.Zone
	for offset := 0; offset < 100000; offset += 3000 {
		res, err := p.call(ctx, "Domain.List", url.Values{"type": {"all"}, "offset": {strconv.Itoa(offset)}, "length": {"3000"}}, "9") // 9: no domains
		if err != nil {
			return nil, err
		}
		for _, d := range res.Domains {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(d.Name) + "."})
		}
		if len(res.Domains) < 3000 {
			return zones, nil
		}
	}
	return zones, nil
}
