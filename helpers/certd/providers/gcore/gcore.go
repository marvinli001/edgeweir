// Package gcore is the Gcore Managed DNS adapter for the RRset API
// (https://api.gcore.com/dns/v2, https://docs.gcore.com/api-reference/dns):
// JSON over HTTPS with a permanent API token ("Authorization: APIKey
// <token>"). One RRset per (name, type); PUT creates or replaces it.
//
// The published libdns module (github.com/libdns/gcore, built for libdns
// v1.0.0-beta.1) keeps only the last member of each RRset in GetRecords,
// duplicates members in AppendRecords and appends instead of replacing in
// SetRecords (failing for new RRsets), so this adapter calls the API
// directly instead of wrapping it or its SDK.
package gcore

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

const endpoint = "https://api.gcore.com/dns"

// Permanent API tokens are "<id>$<secret>".
var tokenPattern = regexp.MustCompile(`^[0-9]+\$[A-Za-z0-9._~+/=-]+$`)

// Provider talks to one Gcore account.
type Provider struct {
	token   string
	baseURL string
	client  *http.Client
	mu      sync.Mutex // RRset edits are read-modify-write; serialize them
}

// New builds the adapter from the catalog fields (api_key).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	token := fields["api_key"]
	if len(token) > 4096 || !tokenPattern.MatchString(token) {
		return nil, fmt.Errorf("%w: Gcore api_key must be a permanent API token (\"<id>$<secret>\")", dnsx.ErrInvalid)
	}
	return &Provider{token: token, baseURL: opts.Endpoint(endpoint), client: opts.Client()}, nil
}

// resourceRecord keeps the member's metadata so rewrites preserve it.
type resourceRecord struct {
	Content []any           `json:"content"`
	Enabled *bool           `json:"enabled,omitempty"`
	Meta    json.RawMessage `json:"meta,omitempty"`
}

type rrset struct {
	Name    string           `json:"name,omitempty"`
	Type    string           `json:"type,omitempty"`
	TTL     int              `json:"ttl"`
	Records []resourceRecord `json:"resource_records"`
	Meta    json.RawMessage  `json:"meta,omitempty"`
	Pickers json.RawMessage  `json:"pickers,omitempty"`
}

// input is the InputRRSet body: output-only fields (name, type) dropped,
// empty metadata omitted.
func (s rrset) input() rrset {
	s.Name, s.Type = "", ""
	if string(s.Meta) == "null" || string(s.Meta) == "{}" {
		s.Meta = nil
	}
	if string(s.Pickers) == "null" || string(s.Pickers) == "[]" {
		s.Pickers = nil
	}
	for i := range s.Records {
		if string(s.Records[i].Meta) == "null" || string(s.Records[i].Meta) == "{}" {
			s.Records[i].Meta = nil
		}
	}
	return s
}

// data renders a member's content in zone-file order ("10 mail.example.com").
func (r resourceRecord) data() string {
	parts := make([]string, 0, len(r.Content))
	for _, c := range r.Content {
		switch v := c.(type) {
		case string:
			parts = append(parts, v)
		case float64:
			parts = append(parts, strconv.FormatFloat(v, 'f', -1, 64))
		default:
			raw, _ := json.Marshal(v)
			parts = append(parts, string(raw))
		}
	}
	return strings.Join(parts, " ")
}

func (p *Provider) describe(body []byte) string {
	var e struct {
		Error   string `json:"error"`
		Message string `json:"message"`
		Detail  string `json:"detail"`
	}
	if json.Unmarshal(body, &e) != nil {
		return ""
	}
	text := e.Error
	if text == "" {
		text = e.Message
	}
	if text == "" {
		text = e.Detail
	}
	// Authentication errors quote part of the token ("Bad permanent token:
	// <partial key>"): drop every word that is a piece of it.
	text = strings.ReplaceAll(text, p.token, "***")
	return tokenish.ReplaceAllStringFunc(text, func(word string) string {
		if strings.Contains(p.token, word) {
			return "***"
		}
		return word
	})
}

var tokenish = regexp.MustCompile(`[A-Za-z0-9._~+/=$-]{6,}`)

func (p *Provider) do(ctx context.Context, method, path string, query url.Values, in, out any) error {
	target := p.baseURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	header := http.Header{"Authorization": {"APIKey " + p.token}, "User-Agent": {"edgeweir-certd/1"}}
	if err := dnsx.JSON(ctx, p.client, method, target, header, in, out, p.describe); err != nil {
		return fmt.Errorf("Gcore %s: %w", method, err)
	}
	return nil
}

func zonePath(zone string) string { return "/v2/zones/" + url.PathEscape(dnsx.Zone(zone)) }

// rrsetPath addresses an RRset by its FQDN (the apex is the zone name).
func rrsetPath(zone, name, typ string) string {
	return zonePath(zone) + "/" + url.PathEscape(strings.ToLower(dnsx.FQDN(name, zone))) + "/" + url.PathEscape(strings.ToUpper(typ))
}

func toRRs(s rrset, zone string) []libdns.RR {
	out := make([]libdns.RR, 0, len(s.Records))
	for _, r := range s.Records {
		data := r.data()
		if strings.EqualFold(s.Type, "TXT") {
			data = dnsx.Unquote(data)
		}
		out = append(out, dnsx.RR(dnsx.Relative(s.Name, zone), s.Type, data, s.TTL))
	}
	return out
}

// GetRecords lists every record of the zone (1000 RRsets per page).
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	const limit = 1000
	var out []libdns.Record
	for offset := 0; ; offset += limit {
		var page struct {
			RRsets []rrset `json:"rrsets"`
			Total  int     `json:"total_amount"`
		}
		query := url.Values{"limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa(offset)}}
		if err := p.do(ctx, http.MethodGet, zonePath(zone)+"/rrsets", query, nil, &page); err != nil {
			return nil, err
		}
		for _, s := range page.RRsets {
			for _, r := range toRRs(s, zone) {
				out = append(out, r)
			}
		}
		if len(out) > 100000 {
			return nil, fmt.Errorf("%w: Gcore zone exceeds 100000 records", dnsx.ErrProvider)
		}
		if len(page.RRsets) < limit || offset+len(page.RRsets) >= page.Total {
			return out, nil
		}
	}
}

// get returns an RRset, or nil when it does not exist.
func (p *Provider) get(ctx context.Context, zone, name, typ string) (*rrset, error) {
	var s rrset
	err := p.do(ctx, http.MethodGet, rrsetPath(zone, name, typ), nil, nil, &s)
	var status *dnsx.StatusError
	if errors.As(err, &status) && status.Status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.Name, s.Type = dnsx.FQDN(name, zone), strings.ToUpper(typ)
	return &s, nil
}

func (p *Provider) put(ctx context.Context, zone string, name, typ string, s rrset) error {
	return p.do(ctx, http.MethodPut, rrsetPath(zone, name, typ), nil, s.input(), nil)
}

// group splits validated input into RRsets, in input order, without
// duplicate members.
func group(records []libdns.Record) ([][]libdns.RR, error) {
	index := map[string]int{}
	seen := map[string]bool{}
	var sets [][]libdns.RR
	for _, r := range dnsx.RRs(records) {
		r.Type = strings.ToUpper(r.Type)
		switch r.Type {
		case "A", "AAAA", "CNAME", "TXT":
		default:
			return nil, fmt.Errorf("%w: Gcore adapter writes A, AAAA, CNAME and TXT records", dnsx.ErrUnsupported)
		}
		if r.Name == "" {
			return nil, fmt.Errorf("%w: record name is empty", dnsx.ErrInvalid)
		}
		if seen[dnsx.Key(r)] {
			continue
		}
		seen[dnsx.Key(r)] = true
		i, ok := index[dnsx.SetKey(r)]
		if !ok {
			i = len(sets)
			index[dnsx.SetKey(r)] = i
			sets = append(sets, nil)
		}
		sets[i] = append(sets[i], r)
	}
	return sets, nil
}

func member(r libdns.RR) resourceRecord {
	data := r.Data
	if r.Type == "TXT" {
		data = dnsx.Unquote(data)
	}
	return resourceRecord{Content: []any{data}}
}

// AppendRecords adds the records to their RRsets; existing members and the
// RRset's TTL, metadata and pickers stay as they are.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	sets, err := group(records)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var done []libdns.Record
	for _, in := range sets {
		first := in[0]
		current, err := p.get(ctx, zone, first.Name, first.Type)
		if err != nil {
			return done, err
		}
		next := rrset{TTL: dnsx.Seconds(first.TTL)}
		if current != nil {
			next = *current
		}
		present := map[string]bool{}
		for _, r := range toRRs(next, zone) {
			present[dnsx.Key(r)] = true
		}
		var added []libdns.Record
		for _, r := range in {
			if present[dnsx.Key(r)] {
				continue
			}
			next.Records = append(next.Records, member(r))
			added = append(added, dnsx.RR(r.Name, r.Type, r.Data, next.TTL))
		}
		if len(added) == 0 {
			continue
		}
		if err := p.put(ctx, zone, first.Name, first.Type, next); err != nil {
			return done, err
		}
		done = append(done, added...)
	}
	return done, nil
}

// SetRecords replaces each input RRset with exactly the input records (one
// PUT per RRset; the first record's TTL applies to the RRset).
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	sets, err := group(records)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var done []libdns.Record
	for _, in := range sets {
		first := in[0]
		next := rrset{TTL: dnsx.Seconds(first.TTL)}
		for _, r := range in {
			next.Records = append(next.Records, member(r))
		}
		if err := p.put(ctx, zone, first.Name, first.Type, next); err != nil {
			return done, err
		}
		for _, r := range in {
			done = append(done, dnsx.RR(r.Name, r.Type, r.Data, next.TTL))
		}
	}
	return done, nil
}

// DeleteRecords removes the matching members (data empty: the whole RRset);
// an RRset left empty is deleted, others are rewritten with their metadata.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var order []string
	inputs := map[string][]libdns.RR{}
	for _, r := range dnsx.RRs(records) {
		key := dnsx.SetKey(r)
		if _, ok := inputs[key]; !ok {
			order = append(order, key)
		}
		inputs[key] = append(inputs[key], r)
	}
	var deleted []libdns.Record
	for _, key := range order {
		in := inputs[key]
		current, err := p.get(ctx, zone, in[0].Name, in[0].Type)
		if err != nil {
			return deleted, err
		}
		if current == nil {
			continue
		}
		var keep []resourceRecord
		var gone []libdns.Record
		for i, rr := range toRRs(*current, zone) {
			rr.Name = in[0].Name
			matched := false
			for _, want := range in {
				if dnsx.Matches(rr, want) {
					matched = true
					break
				}
			}
			if matched {
				gone = append(gone, rr)
			} else {
				keep = append(keep, current.Records[i])
			}
		}
		if len(gone) == 0 {
			continue
		}
		if len(keep) == 0 {
			err = p.do(ctx, http.MethodDelete, rrsetPath(zone, in[0].Name, in[0].Type), nil, nil, nil)
		} else {
			current.Records = keep
			err = p.put(ctx, zone, in[0].Name, in[0].Type, *current)
		}
		if err != nil {
			return deleted, err
		}
		deleted = append(deleted, gone...)
	}
	return deleted, nil
}

// ListZones lists the account's zones (1000 per page).
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	const limit = 1000
	var zones []libdns.Zone
	for offset := 0; offset < 100000; offset += limit {
		var page struct {
			Zones []struct {
				Name string `json:"name"`
			} `json:"zones"`
			Total int `json:"total_amount"`
		}
		query := url.Values{"limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa(offset)}}
		if err := p.do(ctx, http.MethodGet, "/v2/zones", query, nil, &page); err != nil {
			return nil, err
		}
		for _, z := range page.Zones {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(z.Name) + "."})
		}
		if len(page.Zones) < limit || offset+len(page.Zones) >= page.Total {
			return zones, nil
		}
	}
	return nil, fmt.Errorf("%w: Gcore account exceeds 100000 zones", dnsx.ErrProvider)
}
