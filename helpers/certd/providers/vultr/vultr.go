// Package vultr is the Vultr DNS adapter for API v2
// (https://www.vultr.com/api/#tag/dns): bearer API key, one object per
// record, cursor pagination (meta.links.next). The published libdns module
// pulls govultr and oauth2. Requests only pass when the console's egress
// address is in the key's API access control list.
package vultr

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

const (
	endpoint   = "https://api.vultr.com"
	userAgent  = "edgeweir-certd/1"
	perPage    = 500 // API maximum
	maxRecords = 100000
)

// Provider talks to one Vultr account (user API key).
type Provider struct {
	key    string
	base   string
	client *http.Client
	mu     sync.Mutex // writes are per record; serialize read-modify-write
}

// New builds the adapter from the catalog fields (api_key).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	key := fields["api_key"]
	if !validKey(key) {
		return nil, fmt.Errorf("%w: Vultr api_key is malformed", dnsx.ErrInvalid)
	}
	return &Provider{key: key, base: opts.Endpoint(endpoint), client: opts.Client()}, nil
}

// validKey accepts printable ASCII without spaces (keys are 36 upper-case
// letters and digits).
func validKey(s string) bool {
	if len(s) < 16 || len(s) > 512 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] <= ' ' || s[i] > '~' {
			return false
		}
	}
	return true
}

type record struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Name string `json:"name"`
	Data string `json:"data"`
	TTL  int    `json:"ttl"`
}

type body struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Data string `json:"data"`
	TTL  int    `json:"ttl"`
}

type meta struct {
	Links struct {
		Next string `json:"next"`
	} `json:"links"`
}

// describe returns the error text ({"error":"...","status":401}).
func describe(raw []byte) string {
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &e) != nil {
		return ""
	}
	return e.Error
}

func (p *Provider) call(ctx context.Context, method, path string, query url.Values, in, out any) error {
	target := p.base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	header := http.Header{}
	header.Set("Authorization", "Bearer "+p.key)
	header.Set("User-Agent", userAgent)
	return dnsx.JSON(ctx, p.client, method, target, header, in, out, describe)
}

func domainPath(zone string) (string, error) {
	z := dnsx.Zone(zone)
	if z == "" || strings.ContainsAny(z, "/?#% ") {
		return "", fmt.Errorf("%w: invalid zone %q", dnsx.ErrInvalid, zone)
	}
	return "/v2/domains/" + url.PathEscape(z), nil
}

// pages calls a cursor-paginated list until meta.links.next is empty.
func (p *Provider) pages(ctx context.Context, path string, each func(raw json.RawMessage) (int, error)) error {
	cursor, seen, total := "", map[string]bool{}, 0
	for {
		query := url.Values{"per_page": {strconv.Itoa(perPage)}}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		var res json.RawMessage
		if err := p.call(ctx, http.MethodGet, path, query, nil, &res); err != nil {
			return err
		}
		n, err := each(res)
		if err != nil {
			return err
		}
		var page struct {
			Meta meta `json:"meta"`
		}
		_ = json.Unmarshal(res, &page)
		total += n
		if total > maxRecords {
			return fmt.Errorf("%w: Vultr list exceeds %d entries", dnsx.ErrProvider, maxRecords)
		}
		next := page.Meta.Links.Next
		if next == "" || n == 0 {
			return nil
		}
		if seen[next] {
			return fmt.Errorf("%w: Vultr repeated a page cursor", dnsx.ErrProvider)
		}
		seen[next] = true
		cursor = next
	}
}

func (p *Provider) list(ctx context.Context, zone string) ([]record, error) {
	path, err := domainPath(zone)
	if err != nil {
		return nil, err
	}
	var all []record
	err = p.pages(ctx, path+"/records", func(raw json.RawMessage) (int, error) {
		var res struct {
			Records []record `json:"records"`
		}
		if json.Unmarshal(raw, &res) != nil {
			return 0, fmt.Errorf("%w: invalid Vultr response", dnsx.ErrProvider)
		}
		all = append(all, res.Records...)
		return len(res.Records), nil
	})
	return all, err
}

// toRR converts a Vultr record: names are relative ("" for the apex) and
// TXT data comes back quoted.
func toRR(r record, zone string) libdns.RR {
	data := r.Data
	if strings.EqualFold(r.Type, "TXT") {
		data = dnsx.Unquote(data)
	}
	return dnsx.RR(dnsx.Relative(r.Name, zone), r.Type, data, r.TTL)
}

func normalize(records []libdns.Record, zone string) []libdns.RR {
	out := dnsx.RRs(records)
	for i := range out {
		out[i] = dnsx.RR(dnsx.Relative(out[i].Name, zone), out[i].Type, out[i].Data, dnsx.Seconds(out[i].TTL))
	}
	return out
}

// toBody builds a record object: the apex is an empty name, CNAME targets
// are host names without the trailing dot, TXT data is sent unquoted (Vultr
// adds the quotes).
func toBody(r libdns.RR) body {
	name := r.Name
	if name == "@" {
		name = ""
	}
	data := r.Data
	if r.Type == "CNAME" {
		data = strings.TrimSuffix(data, ".")
	}
	return body{Name: name, Type: r.Type, Data: data, TTL: dnsx.Seconds(r.TTL)}
}

// GetRecords lists every record of the zone.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	all, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	out := make([]libdns.Record, 0, len(all))
	for _, r := range all {
		out = append(out, toRR(r, zone))
	}
	return out, nil
}

func (p *Provider) create(ctx context.Context, path string, r libdns.RR) error {
	return p.call(ctx, http.MethodPost, path+"/records", nil, toBody(r), nil)
}

func (p *Provider) remove(ctx context.Context, path, id string) error {
	return p.call(ctx, http.MethodDelete, path+"/records/"+url.PathEscape(id), nil, nil, nil)
}

// AppendRecords creates the records.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	path, err := domainPath(zone)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var done []libdns.Record
	for _, r := range normalize(records, zone) {
		if err := p.create(ctx, path, r); err != nil {
			return done, err
		}
		done = append(done, r)
	}
	return done, nil
}

// SetRecords makes each input RRset exactly the input records: members that
// already exist are kept (TTL changes are patched), others are removed or
// created.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	path, err := domainPath(zone)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	existing, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	input := normalize(records, zone)
	sets := map[string]bool{}
	wanted := map[string]libdns.RR{}
	for _, r := range input {
		sets[dnsx.SetKey(r)] = true
		wanted[dnsx.Key(r)] = r
	}
	kept := map[string]bool{}
	for _, old := range existing {
		rr := toRR(old, zone)
		if !sets[dnsx.SetKey(rr)] {
			continue
		}
		want, keep := wanted[dnsx.Key(rr)]
		if keep && !kept[dnsx.Key(rr)] {
			kept[dnsx.Key(rr)] = true
			if ttl := dnsx.Seconds(want.TTL); ttl != old.TTL {
				if err := p.call(ctx, http.MethodPatch, path+"/records/"+url.PathEscape(old.ID), nil, map[string]int{"ttl": ttl}, nil); err != nil {
					return nil, err
				}
			}
			continue
		}
		if err := p.remove(ctx, path, old.ID); err != nil {
			return nil, err
		}
	}
	for _, r := range input {
		if kept[dnsx.Key(r)] {
			continue
		}
		kept[dnsx.Key(r)] = true
		if err := p.create(ctx, path, r); err != nil {
			return nil, err
		}
	}
	return dnsx.Records(input), nil
}

// DeleteRecords removes the matching records (data empty: the whole RRset).
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	path, err := domainPath(zone)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	existing, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	input := dnsx.RRs(records)
	for i := range input {
		input[i].Name = dnsx.Relative(input[i].Name, zone)
	}
	var deleted []libdns.Record
	for _, old := range existing {
		rr := toRR(old, zone)
		for _, in := range input {
			if dnsx.Matches(rr, in) {
				if err := p.remove(ctx, path, old.ID); err != nil {
					return deleted, err
				}
				deleted = append(deleted, rr)
				break
			}
		}
	}
	return deleted, nil
}

// ListZones lists the account's DNS domains.
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var zones []libdns.Zone
	err := p.pages(ctx, "/v2/domains", func(raw json.RawMessage) (int, error) {
		var res struct {
			Domains []struct {
				Domain string `json:"domain"`
			} `json:"domains"`
		}
		if json.Unmarshal(raw, &res) != nil {
			return 0, fmt.Errorf("%w: invalid Vultr response", dnsx.ErrProvider)
		}
		for _, d := range res.Domains {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(d.Domain) + "."})
		}
		return len(res.Domains), nil
	})
	if err != nil {
		return nil, err
	}
	return zones, nil
}
