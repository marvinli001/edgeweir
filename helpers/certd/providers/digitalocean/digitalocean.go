// Package digitalocean is the DigitalOcean DNS adapter for API v2
// (https://docs.digitalocean.com/reference/api/digitalocean/#tag/Domain-Records):
// bearer token, one object per record, page/per_page pagination. The
// published libdns module pulls the godo SDK.
package digitalocean

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
	endpoint   = "https://api.digitalocean.com"
	userAgent  = "edgeweir-certd/1"
	perPage    = 200 // API maximum
	maxRecords = 100000
	minTTL     = 30 // "All DNS records require a minimum TTL value of 30 seconds."
)

// Provider talks to one DigitalOcean account or team.
type Provider struct {
	token  string
	base   string
	client *http.Client
	mu     sync.Mutex // writes are per record; serialize read-modify-write
}

// New builds the adapter from the catalog fields (api_token).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	token := fields["api_token"]
	if !validToken(token) {
		return nil, fmt.Errorf("%w: DigitalOcean api_token is malformed", dnsx.ErrInvalid)
	}
	return &Provider{token: token, base: opts.Endpoint(endpoint), client: opts.Client()}, nil
}

// validToken accepts printable ASCII without spaces (personal access tokens
// are "dop_v1_" plus 64 hex digits).
func validToken(s string) bool {
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
	ID   int64  `json:"id"`
	Type string `json:"type"`
	Name string `json:"name"`
	Data string `json:"data"`
	TTL  int    `json:"ttl"`
}

type body struct {
	Type string `json:"type"`
	Name string `json:"name"`
	Data string `json:"data"`
	TTL  int    `json:"ttl"`
}

type links struct {
	Pages struct {
		Next string `json:"next"`
	} `json:"pages"`
}

// describe returns the error id and message ({"id":"not_found","message":"..."}).
func describe(raw []byte) string {
	var e struct {
		ID      string `json:"id"`
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &e) != nil {
		return ""
	}
	return strings.Trim(e.ID+": "+e.Message, ": ")
}

func (p *Provider) call(ctx context.Context, method, path string, query url.Values, in, out any) error {
	target := p.base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	header := http.Header{}
	header.Set("Authorization", "Bearer "+p.token)
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

func (p *Provider) list(ctx context.Context, zone string) ([]record, error) {
	path, err := domainPath(zone)
	if err != nil {
		return nil, err
	}
	var all []record
	for page := 1; ; page++ {
		var res struct {
			Records []record `json:"domain_records"`
			Links   links    `json:"links"`
		}
		query := url.Values{"page": {strconv.Itoa(page)}, "per_page": {strconv.Itoa(perPage)}}
		if err := p.call(ctx, http.MethodGet, path+"/records", query, nil, &res); err != nil {
			return nil, err
		}
		all = append(all, res.Records...)
		if len(all) > maxRecords {
			return nil, fmt.Errorf("%w: DigitalOcean zone exceeds %d records", dnsx.ErrProvider, maxRecords)
		}
		if res.Links.Pages.Next == "" || len(res.Records) == 0 {
			return all, nil
		}
	}
}

func toRR(r record, zone string) libdns.RR {
	data := r.Data
	switch strings.ToUpper(r.Type) {
	case "TXT":
		data = dnsx.Unquote(data)
	case "CNAME":
		if data == "@" {
			data = dnsx.Zone(zone) + "."
		}
	}
	return dnsx.RR(dnsx.Name(r.Name, zone), r.Type, data, r.TTL)
}

// normalize makes input names relative ("@" for the apex), types upper
// case and TTLs what the API stores.
func normalize(records []libdns.Record, zone string) []libdns.RR {
	out := dnsx.RRs(records)
	for i := range out {
		out[i].Name = dnsx.Name(out[i].Name, zone)
		out[i].Type = strings.ToUpper(out[i].Type)
		out[i] = dnsx.RR(out[i].Name, out[i].Type, out[i].Data, ttlOf(out[i]))
	}
	return out
}

func ttlOf(r libdns.RR) int { return max(dnsx.Seconds(r.TTL), minTTL) }

// toBody builds a record object; CNAME targets must end with a dot.
func toBody(r libdns.RR) body {
	data := r.Data
	if r.Type == "CNAME" {
		data = strings.TrimSuffix(data, ".") + "."
	}
	return body{Type: r.Type, Name: r.Name, Data: data, TTL: ttlOf(r)}
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

func (p *Provider) remove(ctx context.Context, path string, id int64) error {
	return p.call(ctx, http.MethodDelete, path+"/records/"+strconv.FormatInt(id, 10), nil, nil, nil)
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
// already exist are kept (TTL changes are rewritten), others are removed or
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
			if ttlOf(want) != old.TTL {
				if err := p.call(ctx, http.MethodPut, path+"/records/"+strconv.FormatInt(old.ID, 10), nil, toBody(want), nil); err != nil {
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
		input[i].Name = dnsx.Name(input[i].Name, zone)
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

// ListZones lists the account's domains.
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var zones []libdns.Zone
	for page := 1; page <= maxRecords/perPage; page++ {
		var res struct {
			Domains []struct {
				Name string `json:"name"`
			} `json:"domains"`
			Links links `json:"links"`
		}
		query := url.Values{"page": {strconv.Itoa(page)}, "per_page": {strconv.Itoa(perPage)}}
		if err := p.call(ctx, http.MethodGet, "/v2/domains", query, nil, &res); err != nil {
			return nil, err
		}
		for _, d := range res.Domains {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(d.Name) + "."})
		}
		if res.Links.Pages.Next == "" || len(res.Domains) == 0 {
			return zones, nil
		}
	}
	return nil, fmt.Errorf("%w: DigitalOcean account exceeds %d domains", dnsx.ErrProvider, maxRecords)
}
