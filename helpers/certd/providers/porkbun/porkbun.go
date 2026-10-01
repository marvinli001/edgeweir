// Package porkbun is the Porkbun adapter for the v3 JSON API
// (https://porkbun.com/api/json/v3/documentation): API key and secret API key
// in the JSON body of every POST, records addressed by ID. API access has to
// be turned on for each domain in the Porkbun account. The libdns module
// (v1.1.0) is not used: its SetRecords rewrites every member of an RRset to
// the same value, its DeleteRecords removes the whole RRset whatever the
// data, and it ignores the context.
package porkbun

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	endpoint    = "https://api.porkbun.com/api/json/v3"
	userAgent   = "edgeweir-certd/1"
	maxRecords  = 100000
	domainsPage = 1000 // listAll returns up to 1000 domains per call
	minTTL      = 600  // account minimum ("typically 600")
)

var (
	apiKeyPattern = regexp.MustCompile(`^pk1_[A-Za-z0-9_]{8,256}$`)
	secretPattern = regexp.MustCompile(`^sk1_[A-Za-z0-9_]{8,256}$`)
)

// Provider talks to one Porkbun account.
type Provider struct {
	apiKey, secretKey string
	base              string
	client            *http.Client
	mu                sync.Mutex // read-modify-write per provider
}

// New builds the adapter from the catalog fields (api_key, api_secret_key).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	if !apiKeyPattern.MatchString(fields["api_key"]) {
		return nil, fmt.Errorf("%w: Porkbun api_key must start with pk1_", dnsx.ErrInvalid)
	}
	if !secretPattern.MatchString(fields["api_secret_key"]) {
		return nil, fmt.Errorf("%w: Porkbun api_secret_key must start with sk1_", dnsx.ErrInvalid)
	}
	return &Provider{apiKey: fields["api_key"], secretKey: fields["api_secret_key"], base: opts.Endpoint(endpoint), client: opts.Client()}, nil
}

// flex reads a value the API sends as a string or a number.
type flex string

func (f *flex) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		*f = ""
		return nil
	}
	var s string
	if json.Unmarshal(b, &s) == nil {
		*f = flex(s)
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	*f = flex(n.String())
	return nil
}

type record struct {
	ID      flex   `json:"id"`
	Name    string `json:"name"` // fully qualified
	Type    string `json:"type"`
	Content string `json:"content"`
	TTL     flex   `json:"ttl"`
	Prio    flex   `json:"prio"`
}

type response struct {
	Status     string `json:"status"`
	Message    string `json:"message"`
	Code       string `json:"code"`
	NextAction *struct {
		Type string `json:"type"`
	} `json:"next_action"`
	Records []record `json:"records"`
	Domains []struct {
		Domain string `json:"domain"`
	} `json:"domains"`
}

var errorKinds = map[string]error{
	"API_KEY_REQUIRED":     dnsx.ErrAuth,
	"INVALID_API_KEYS_001": dnsx.ErrAuth,
	"INVALID_TOKEN":        dnsx.ErrAuth,
	"INVALID_USER":         dnsx.ErrAuth,
	"IP_NOT_ALLOWED":       dnsx.ErrAuth,
	"DOMAIN_NOT_ALLOWED":   dnsx.ErrAuth,
	"DOMAIN_NOT_FOUND":     dnsx.ErrZoneNotFound,
	"INVALID_DOMAIN":       dnsx.ErrZoneNotFound,
	"RATE_LIMIT_EXCEEDED":  dnsx.ErrRateLimited,
}

func apiError(action string, status int, out response) error {
	kind := dnsx.ErrProvider
	if status < 200 || status > 299 {
		kind = (&dnsx.StatusError{Status: status}).Kind()
	}
	if k, ok := errorKinds[out.Code]; ok {
		kind = k
	} else if out.NextAction != nil && (out.NextAction.Type == "authenticate" || out.NextAction.Type == "enable_setting") {
		kind = dnsx.ErrAuth // e.g. API access not enabled for the domain
	}
	return fmt.Errorf("%w: Porkbun %s HTTP %d %s", kind, action, status, dnsx.Short(strings.TrimSpace(out.Code+" "+out.Message)))
}

// call POSTs to an endpoint with the credentials in the body; codes in ok
// count as success.
func (p *Provider) call(ctx context.Context, action, path string, fields map[string]any, ok ...string) (*response, error) {
	body := map[string]any{"apikey": p.apiKey, "secretapikey": p.secretKey}
	maps.Copy(body, fields)
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("%w: encoding request", dnsx.ErrInvalid)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.base+path, bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	status, answer, err := dnsx.Do(p.client, req)
	if err != nil {
		return nil, err
	}
	var out response
	if json.Unmarshal(answer, &out) != nil {
		if status >= 200 && status <= 299 {
			return nil, fmt.Errorf("%w: invalid Porkbun response", dnsx.ErrProvider)
		}
		return nil, apiError(action, status, out)
	}
	if status >= 200 && status <= 299 && out.Status == "SUCCESS" {
		return &out, nil
	}
	if out.Code != "" && slices.Contains(ok, out.Code) {
		return &out, nil
	}
	return nil, apiError(action, status, out)
}

func domain(zone string) string { return url.PathEscape(dnsx.Zone(zone)) }

// sub is Porkbun's name form: empty for the apex.
func sub(name string) string {
	if name == "@" {
		return ""
	}
	return strings.ToLower(name)
}

func toRR(zone string, r record) libdns.RR {
	data := r.Content
	switch r.Type {
	case "TXT":
		data = dnsx.Unquote(data)
	case "MX", "SRV":
		if r.Prio != "" {
			data = string(r.Prio) + " " + data
		}
	}
	ttl, _ := strconv.Atoi(string(r.TTL))
	return dnsx.RR(dnsx.Relative(r.Name, zone), r.Type, data, ttl)
}

func ttl(r libdns.RR) int { return max(dnsx.Seconds(r.TTL), minTTL) }

// content is Porkbun's value form: hostnames without the trailing dot.
func content(r libdns.RR) string {
	switch strings.ToUpper(r.Type) {
	case "CNAME", "ALIAS":
		return strings.TrimSuffix(r.Data, ".")
	}
	return r.Data
}

func (p *Provider) list(ctx context.Context, zone string) ([]record, error) {
	res, err := p.call(ctx, "dns/retrieve", "/dns/retrieve/"+domain(zone), nil)
	if err != nil {
		return nil, err
	}
	if len(res.Records) > maxRecords {
		return nil, fmt.Errorf("%w: Porkbun zone exceeds %d records", dnsx.ErrProvider, maxRecords)
	}
	return res.Records, nil
}

// create adds one record; an identical existing record counts as created.
func (p *Provider) create(ctx context.Context, zone string, r libdns.RR) error {
	_, err := p.call(ctx, "dns/create", "/dns/create/"+domain(zone), map[string]any{
		"name": sub(r.Name), "type": strings.ToUpper(r.Type), "content": content(r), "ttl": ttl(r),
	}, "DUPLICATE_RECORD")
	return err
}

func (p *Provider) remove(ctx context.Context, zone string, id flex) error {
	_, err := p.call(ctx, "dns/delete", "/dns/delete/"+domain(zone)+"/"+url.PathEscape(string(id)), nil)
	return err
}

// GetRecords lists every record of the zone (SOA and Porkbun's default NS
// records are not included).
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	all, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	out := make([]libdns.Record, 0, len(all))
	for _, r := range all {
		out = append(out, toRR(zone, r))
	}
	return out, nil
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
		done = append(done, dnsx.RR(r.Name, r.Type, r.Data, ttl(r)))
	}
	return done, nil
}

// SetRecords makes each input RRset exactly the input records: members that
// already exist are kept (TTL rewritten when it differs), others are
// removed or created.
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
		if _, dup := wanted[dnsx.Key(r)]; !dup {
			wanted[dnsx.Key(r)] = r
		}
	}
	kept := map[string]bool{}
	for _, old := range existing {
		rr := toRR(zone, old)
		if !sets[dnsx.SetKey(rr)] {
			continue
		}
		key := dnsx.Key(rr)
		if want, ok := wanted[key]; ok && !kept[key] {
			kept[key] = true
			if dnsx.Seconds(rr.TTL) != ttl(want) {
				if _, err := p.call(ctx, "dns/edit", "/dns/edit/"+domain(zone)+"/"+url.PathEscape(string(old.ID)), map[string]any{
					"name": sub(rr.Name), "type": old.Type, "content": old.Content, "ttl": ttl(want),
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
	input := dnsx.RRs(records)
	var deleted []libdns.Record
	for _, old := range existing {
		rr := toRR(zone, old)
		if slices.ContainsFunc(input, func(in libdns.RR) bool { return dnsx.Matches(rr, in) }) {
			if err := p.remove(ctx, zone, old.ID); err != nil {
				return deleted, err
			}
			deleted = append(deleted, rr)
		}
	}
	return deleted, nil
}

// ListZones lists the account's domains (including those without API
// access, whose record calls fail).
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var zones []libdns.Zone
	for start := 0; start <= maxRecords; start += domainsPage {
		res, err := p.call(ctx, "domain/listAll", "/domain/listAll", map[string]any{"start": start})
		if err != nil {
			return nil, err
		}
		for _, d := range res.Domains {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(d.Domain) + "."})
		}
		if len(res.Domains) < domainsPage {
			break
		}
	}
	return zones, nil
}
