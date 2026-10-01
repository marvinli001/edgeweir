// Package bunny is the Bunny DNS adapter for the bunny.net core API
// (https://docs.bunny.net/api-reference/core/dns-zone): JSON over HTTPS with
// the account API key in the AccessKey header, zones and records addressed
// by numeric IDs.
//
// The published libdns module (github.com/libdns/bunny v1.6.1) ignores
// delete failures in SetRecords, cannot delete a whole RRset, returns its
// input instead of the deleted records, reads zones without paging and
// sends the key through a client that follows redirects (the custom
// AccessKey header is forwarded to any redirect target), so this adapter
// calls the API directly.
package bunny

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const endpoint = "https://api.bunny.net"

var keyPattern = regexp.MustCompile(`^[A-Za-z0-9-]{16,128}$`)

// Provider talks to one bunny.net account.
type Provider struct {
	key     string
	baseURL string
	client  *http.Client
	mu      sync.Mutex // record changes are read-modify-write; serialize them
	zones   map[string]int64
}

// New builds the adapter from the catalog fields (access_key).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	key := fields["access_key"]
	if !keyPattern.MatchString(key) {
		return nil, fmt.Errorf("%w: Bunny access_key must be the account API key", dnsx.ErrInvalid)
	}
	return &Provider{key: key, baseURL: opts.Endpoint(endpoint), client: opts.Client(), zones: map[string]int64{}}, nil
}

// Record types (DnsRecordTypes in the API reference).
var typeNames = map[int]string{
	0: "A", 1: "AAAA", 2: "CNAME", 3: "TXT", 4: "MX", 5: "RDR", 6: "FLATTEN", 7: "PZ",
	8: "SRV", 9: "CAA", 10: "PTR", 11: "SCR", 12: "NS", 13: "SVCB", 14: "HTTPS", 15: "TLSA",
}

var typeIDs = map[string]int{"A": 0, "AAAA": 1, "CNAME": 2, "TXT": 3}

type record struct {
	ID       int64  `json:"Id,omitempty"`
	Type     int    `json:"Type"`
	TTL      int    `json:"Ttl"`
	Value    string `json:"Value"`
	Name     string `json:"Name"`
	Weight   int    `json:"Weight,omitempty"`
	Priority int    `json:"Priority,omitempty"`
	Port     int    `json:"Port,omitempty"`
	Flags    int    `json:"Flags,omitempty"`
	Tag      string `json:"Tag,omitempty"`
}

type page[T any] struct {
	Items        []T  `json:"Items"`
	HasMoreItems bool `json:"HasMoreItems"`
}

func (p *Provider) describe(body []byte) string {
	var e struct {
		ErrorKey string `json:"ErrorKey"`
		Field    string `json:"Field"`
		Message  string `json:"Message"`
	}
	if json.Unmarshal(body, &e) != nil {
		return ""
	}
	text := strings.TrimSpace(strings.Join([]string{e.ErrorKey, e.Field, e.Message}, " "))
	return strings.ReplaceAll(text, p.key, "***")
}

func (p *Provider) do(ctx context.Context, method, path string, query url.Values, in, out any) error {
	target := p.baseURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	header := http.Header{"AccessKey": {p.key}, "User-Agent": {"edgeweir-certd/1"}}
	if err := dnsx.JSON(ctx, p.client, method, target, header, in, out, p.describe); err != nil {
		return fmt.Errorf("Bunny %s: %w", method, err)
	}
	return nil
}

// zoneID finds the zone by name (search, then an exact match).
func (p *Provider) zoneID(ctx context.Context, zone string) (int64, error) {
	name := dnsx.Zone(zone)
	if id, ok := p.zones[name]; ok {
		return id, nil
	}
	for n := 1; n <= 100; n++ {
		var res page[struct {
			ID     int64  `json:"Id"`
			Domain string `json:"Domain"`
		}]
		query := url.Values{"search": {name}, "page": {strconv.Itoa(n)}, "perPage": {"1000"}, "view": {"1"}}
		if err := p.do(ctx, http.MethodGet, "/dnszone", query, nil, &res); err != nil {
			return 0, err
		}
		for _, z := range res.Items {
			if strings.EqualFold(strings.TrimSuffix(z.Domain, "."), name) {
				p.zones[name] = z.ID
				return z.ID, nil
			}
		}
		if !res.HasMoreItems {
			break
		}
	}
	return 0, fmt.Errorf("%w: Bunny DNS has no zone %s", dnsx.ErrZoneNotFound, name)
}

func (p *Provider) list(ctx context.Context, id int64) ([]record, error) {
	var all []record
	for n := 1; n <= 100; n++ {
		var res page[record]
		query := url.Values{"page": {strconv.Itoa(n)}, "perPage": {"1000"}}
		if err := p.do(ctx, http.MethodGet, fmt.Sprintf("/dnszone/%d/records", id), query, nil, &res); err != nil {
			return nil, err
		}
		all = append(all, res.Items...)
		if !res.HasMoreItems {
			return all, nil
		}
	}
	return nil, fmt.Errorf("%w: Bunny zone exceeds 100000 records", dnsx.ErrProvider)
}

func toRR(r record) libdns.RR {
	name := r.Name
	if name == "" {
		name = "@"
	}
	typ, ok := typeNames[r.Type]
	if !ok {
		typ = "TYPE" + strconv.Itoa(r.Type)
	}
	data := r.Value
	switch typ {
	case "MX":
		data = fmt.Sprintf("%d %s", r.Priority, r.Value)
	case "SRV":
		data = fmt.Sprintf("%d %d %d %s", r.Priority, r.Weight, r.Port, r.Value)
	case "CAA":
		data = fmt.Sprintf("%d %s %q", r.Flags, r.Tag, r.Value)
	}
	return dnsx.RR(strings.ToLower(name), typ, data, r.TTL)
}

func toBunny(r libdns.RR) (record, error) {
	typ, ok := typeIDs[strings.ToUpper(r.Type)]
	if !ok {
		return record{}, fmt.Errorf("%w: Bunny adapter writes A, AAAA, CNAME and TXT records", dnsx.ErrUnsupported)
	}
	if r.Name == "" {
		return record{}, fmt.Errorf("%w: record name is empty", dnsx.ErrInvalid)
	}
	name := r.Name
	if name == "@" {
		name = ""
	}
	value := r.Data
	if typ == typeIDs["TXT"] {
		value = dnsx.Unquote(value)
	}
	return record{Type: typ, TTL: dnsx.Seconds(r.TTL), Value: value, Name: name}, nil
}

func (p *Provider) create(ctx context.Context, id int64, r libdns.RR) error {
	body, err := toBunny(r)
	if err != nil {
		return err
	}
	return p.do(ctx, http.MethodPut, fmt.Sprintf("/dnszone/%d/records", id), nil, body, nil)
}

func (p *Provider) remove(ctx context.Context, id, record int64) error {
	return p.do(ctx, http.MethodDelete, fmt.Sprintf("/dnszone/%d/records/%d", id, record), nil, nil, nil)
}

func validate(records []libdns.Record) ([]libdns.RR, error) {
	in := dnsx.RRs(records)
	for i := range in {
		in[i].Type = strings.ToUpper(in[i].Type)
		if _, err := toBunny(in[i]); err != nil {
			return nil, err
		}
	}
	return in, nil
}

// GetRecords lists every record of the zone.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	id, err := p.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	all, err := p.list(ctx, id)
	if err != nil {
		return nil, err
	}
	out := make([]libdns.Record, 0, len(all))
	for _, r := range all {
		out = append(out, toRR(r))
	}
	return out, nil
}

// AppendRecords creates the records.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	in, err := validate(records)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	id, err := p.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	var done []libdns.Record
	for _, r := range in {
		if err := p.create(ctx, id, r); err != nil {
			return done, err
		}
		done = append(done, r)
	}
	return done, nil
}

// SetRecords makes each input RRset exactly the input records: existing
// members are kept (TTL updated when it differs), others are deleted or
// created.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	in, err := validate(records)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	id, err := p.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	existing, err := p.list(ctx, id)
	if err != nil {
		return nil, err
	}
	sets := map[string]bool{}
	wanted := map[string]libdns.RR{}
	for _, r := range in {
		sets[dnsx.SetKey(r)] = true
		wanted[dnsx.Key(r)] = r
	}
	kept := map[string]bool{}
	for _, old := range existing {
		rr := toRR(old)
		if !sets[dnsx.SetKey(rr)] {
			continue
		}
		key := dnsx.Key(rr)
		if want, keep := wanted[key]; keep && !kept[key] {
			kept[key] = true
			if dnsx.Seconds(want.TTL) != old.TTL {
				body, _ := toBunny(want)
				if err := p.do(ctx, http.MethodPost, fmt.Sprintf("/dnszone/%d/records/%d", id, old.ID), nil, body, nil); err != nil {
					return nil, err
				}
			}
			continue
		}
		if err := p.remove(ctx, id, old.ID); err != nil {
			return nil, err
		}
	}
	var out []libdns.Record
	created := map[string]bool{}
	for _, r := range in {
		key := dnsx.Key(r)
		if created[key] {
			continue
		}
		created[key] = true
		out = append(out, r)
		if kept[key] {
			continue
		}
		if err := p.create(ctx, id, r); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// DeleteRecords removes the matching records (data empty: the whole RRset)
// and returns them.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	id, err := p.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	existing, err := p.list(ctx, id)
	if err != nil {
		return nil, err
	}
	in := dnsx.RRs(records)
	var deleted []libdns.Record
	for _, old := range existing {
		rr := toRR(old)
		for _, want := range in {
			if dnsx.Matches(rr, want) {
				err := p.remove(ctx, id, old.ID)
				var status *dnsx.StatusError
				if err != nil && !(errors.As(err, &status) && status.Status == http.StatusNotFound) {
					return deleted, err
				}
				deleted = append(deleted, rr)
				break
			}
		}
	}
	return deleted, nil
}

// ListZones lists the account's DNS zones (1000 per page).
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var zones []libdns.Zone
	for n := 1; n <= 100; n++ {
		var res page[struct {
			Domain string `json:"Domain"`
		}]
		query := url.Values{"page": {strconv.Itoa(n)}, "perPage": {"1000"}, "view": {"1"}}
		if err := p.do(ctx, http.MethodGet, "/dnszone", query, nil, &res); err != nil {
			return nil, err
		}
		for _, z := range res.Items {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(z.Domain) + "."})
		}
		if !res.HasMoreItems {
			return zones, nil
		}
	}
	return nil, fmt.Errorf("%w: Bunny account exceeds 100000 zones", dnsx.ErrProvider)
}
