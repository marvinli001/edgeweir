// Package linode is the Akamai (Linode) DNS Manager adapter for API v4
// (https://techdocs.akamai.com/linode-api/reference/get-domains): bearer
// personal access token, domains addressed by numeric ID, one object per
// record, page/pages pagination. The published libdns module pulls
// linodego and resty.
package linode

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
	endpoint   = "https://api.linode.com"
	userAgent  = "edgeweir-certd/1"
	pageSize   = 500 // API maximum
	maxRecords = 100000
)

// ttls are the values ttl_sec accepts; the API rounds any other value to
// the nearest one.
var ttls = []int{300, 3600, 7200, 14400, 28800, 57600, 86400, 172800, 345600, 604800, 1209600, 2419200}

// Provider talks to one Linode account (or restricted user).
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
		return nil, fmt.Errorf("%w: Linode api_token is malformed", dnsx.ErrInvalid)
	}
	return &Provider{token: token, base: opts.Endpoint(endpoint), client: opts.Client()}, nil
}

// validToken accepts printable ASCII without spaces (personal access tokens
// are 64 hex digits).
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

type domain struct {
	ID     int64  `json:"id"`
	Domain string `json:"domain"`
	TTL    int    `json:"ttl_sec"`
}

type record struct {
	ID     int64  `json:"id"`
	Type   string `json:"type"`
	Name   string `json:"name"`
	Target string `json:"target"`
	TTL    int    `json:"ttl_sec"`
}

type body struct {
	Type   string `json:"type"`
	Name   string `json:"name"`
	Target string `json:"target"`
	TTL    int    `json:"ttl_sec"`
}

type page struct {
	Page  int `json:"page"`
	Pages int `json:"pages"`
}

// describe joins the reasons of {"errors":[{"field","reason"}]}.
func describe(raw []byte) string {
	var e struct {
		Errors []struct {
			Field  string `json:"field"`
			Reason string `json:"reason"`
		} `json:"errors"`
	}
	if json.Unmarshal(raw, &e) != nil {
		return ""
	}
	parts := make([]string, 0, len(e.Errors))
	for _, x := range e.Errors {
		if x.Field != "" {
			parts = append(parts, x.Field+": "+x.Reason)
		} else {
			parts = append(parts, x.Reason)
		}
	}
	return strings.Join(parts, "; ")
}

func (p *Provider) call(ctx context.Context, method, path string, query url.Values, filter any, in, out any) error {
	target := p.base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	header := http.Header{}
	header.Set("Authorization", "Bearer "+p.token)
	header.Set("User-Agent", userAgent)
	if filter != nil {
		raw, err := json.Marshal(filter)
		if err != nil {
			return fmt.Errorf("%w: encoding filter", dnsx.ErrInvalid)
		}
		header.Set("X-Filter", string(raw))
	}
	return dnsx.JSON(ctx, p.client, method, target, header, in, out, describe)
}

// paged walks page=1..pages.
func (p *Provider) paged(ctx context.Context, path string, filter any, each func(raw json.RawMessage) (int, error)) error {
	total := 0
	for n := 1; ; n++ {
		var res json.RawMessage
		query := url.Values{"page": {strconv.Itoa(n)}, "page_size": {strconv.Itoa(pageSize)}}
		if err := p.call(ctx, http.MethodGet, path, query, filter, nil, &res); err != nil {
			return err
		}
		count, err := each(res)
		if err != nil {
			return err
		}
		total += count
		if total > maxRecords {
			return fmt.Errorf("%w: Linode list exceeds %d entries", dnsx.ErrProvider, maxRecords)
		}
		var pg page
		_ = json.Unmarshal(res, &pg)
		if n >= pg.Pages || count == 0 {
			return nil
		}
	}
}

// find resolves the zone to its domain ID (filtered by name, verified
// exactly).
func (p *Provider) find(ctx context.Context, zone string) (domain, error) {
	z := dnsx.Zone(zone)
	if z == "" || strings.ContainsAny(z, "/?#% ") {
		return domain{}, fmt.Errorf("%w: invalid zone %q", dnsx.ErrInvalid, zone)
	}
	var found *domain
	err := p.paged(ctx, "/v4/domains", map[string]string{"domain": z}, func(raw json.RawMessage) (int, error) {
		var res struct {
			Data []domain `json:"data"`
		}
		if json.Unmarshal(raw, &res) != nil {
			return 0, fmt.Errorf("%w: invalid Linode response", dnsx.ErrProvider)
		}
		for i, d := range res.Data {
			if found == nil && strings.EqualFold(strings.TrimSuffix(d.Domain, "."), z) {
				found = &res.Data[i]
			}
		}
		return len(res.Data), nil
	})
	if err != nil {
		return domain{}, err
	}
	if found == nil {
		return domain{}, fmt.Errorf("%w: Linode has no domain %s", dnsx.ErrZoneNotFound, z)
	}
	return *found, nil
}

func recordsPath(d domain) string { return "/v4/domains/" + strconv.FormatInt(d.ID, 10) + "/records" }

func (p *Provider) list(ctx context.Context, zone string) (domain, []record, error) {
	d, err := p.find(ctx, zone)
	if err != nil {
		return d, nil, err
	}
	var all []record
	err = p.paged(ctx, recordsPath(d), nil, func(raw json.RawMessage) (int, error) {
		var res struct {
			Data []record `json:"data"`
		}
		if json.Unmarshal(raw, &res) != nil {
			return 0, fmt.Errorf("%w: invalid Linode response", dnsx.ErrProvider)
		}
		all = append(all, res.Data...)
		return len(res.Data), nil
	})
	return d, all, err
}

// effectiveTTL is the record TTL; 0 means the domain default.
func effectiveTTL(r record, d domain) int {
	if r.TTL == 0 {
		return d.TTL
	}
	return r.TTL
}

// toRR converts a Linode record: names are relative ("" for the apex).
func toRR(r record, d domain, zone string) libdns.RR {
	data := r.Target
	if strings.EqualFold(r.Type, "TXT") {
		data = dnsx.Unquote(data)
	}
	return dnsx.RR(dnsx.Relative(r.Name, zone), r.Type, data, effectiveTTL(r, d))
}

// ttlOf maps a TTL to the nearest value the API accepts.
func ttlOf(r libdns.RR) int {
	s, best := dnsx.Seconds(r.TTL), ttls[0]
	for _, v := range ttls {
		if abs(v-s) < abs(best-s) {
			best = v
		}
	}
	return best
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func normalize(records []libdns.Record, zone string) []libdns.RR {
	out := dnsx.RRs(records)
	for i := range out {
		out[i] = dnsx.RR(dnsx.Relative(out[i].Name, zone), out[i].Type, out[i].Data, ttlOf(out[i]))
	}
	return out
}

// toBody builds a record object: the apex is an empty name, CNAME targets
// end with a dot (accepted by the API, never read as zone-relative).
func toBody(r libdns.RR) body {
	name := r.Name
	if name == "@" {
		name = ""
	}
	target := r.Data
	if r.Type == "CNAME" {
		target = strings.TrimSuffix(target, ".") + "."
	}
	return body{Type: r.Type, Name: name, Target: target, TTL: ttlOf(r)}
}

// GetRecords lists every record of the zone.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	d, all, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	out := make([]libdns.Record, 0, len(all))
	for _, r := range all {
		out = append(out, toRR(r, d, zone))
	}
	return out, nil
}

func (p *Provider) create(ctx context.Context, d domain, r libdns.RR) error {
	return p.call(ctx, http.MethodPost, recordsPath(d), nil, nil, toBody(r), nil)
}

func (p *Provider) remove(ctx context.Context, d domain, id int64) error {
	return p.call(ctx, http.MethodDelete, recordsPath(d)+"/"+strconv.FormatInt(id, 10), nil, nil, nil, nil)
}

// AppendRecords creates the records.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	d, err := p.find(ctx, zone)
	if err != nil {
		return nil, err
	}
	var done []libdns.Record
	for _, r := range normalize(records, zone) {
		if err := p.create(ctx, d, r); err != nil {
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
	d, existing, err := p.list(ctx, zone)
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
		rr := toRR(old, d, zone)
		if !sets[dnsx.SetKey(rr)] {
			continue
		}
		want, keep := wanted[dnsx.Key(rr)]
		if keep && !kept[dnsx.Key(rr)] {
			kept[dnsx.Key(rr)] = true
			if ttl := ttlOf(want); ttl != old.TTL {
				path := recordsPath(d) + "/" + strconv.FormatInt(old.ID, 10)
				if err := p.call(ctx, http.MethodPut, path, nil, nil, map[string]int{"ttl_sec": ttl}, nil); err != nil {
					return nil, err
				}
			}
			continue
		}
		if err := p.remove(ctx, d, old.ID); err != nil {
			return nil, err
		}
	}
	for _, r := range input {
		if kept[dnsx.Key(r)] {
			continue
		}
		kept[dnsx.Key(r)] = true
		if err := p.create(ctx, d, r); err != nil {
			return nil, err
		}
	}
	return dnsx.Records(input), nil
}

// DeleteRecords removes the matching records (data empty: the whole RRset).
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	d, existing, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	input := dnsx.RRs(records)
	for i := range input {
		input[i].Name = dnsx.Relative(input[i].Name, zone)
	}
	var deleted []libdns.Record
	for _, old := range existing {
		rr := toRR(old, d, zone)
		for _, in := range input {
			if dnsx.Matches(rr, in) {
				if err := p.remove(ctx, d, old.ID); err != nil {
					return deleted, err
				}
				deleted = append(deleted, rr)
				break
			}
		}
	}
	return deleted, nil
}

// ListZones lists the domains the token can see.
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var zones []libdns.Zone
	err := p.paged(ctx, "/v4/domains", nil, func(raw json.RawMessage) (int, error) {
		var res struct {
			Data []domain `json:"data"`
		}
		if json.Unmarshal(raw, &res) != nil {
			return 0, fmt.Errorf("%w: invalid Linode response", dnsx.ErrProvider)
		}
		for _, d := range res.Data {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(d.Domain) + "."})
		}
		return len(res.Data), nil
	})
	if err != nil {
		return nil, err
	}
	return zones, nil
}
