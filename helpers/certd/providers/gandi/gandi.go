// Package gandi is the Gandi LiveDNS adapter (https://api.gandi.net/docs/livedns/):
// personal access token (Bearer), RRset-based writes (one PUT or DELETE per
// name and type). The libdns module (v1.1.0) is not used: its SetRecords
// appends to RRsets instead of replacing them, its DeleteRecords neither
// deletes whole RRsets nor returns what it deleted, TXT values come back
// quoted, and it calls http.DefaultClient without a timeout.
package gandi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	endpoint   = "https://api.gandi.net/v5/livedns"
	userAgent  = "edgeweir-certd/1"
	perPage    = 500
	maxRecords = 100000
	minTTL     = 300
	maxTTL     = 2592000
)

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{16,512}$`)

// Provider talks to the LiveDNS domains a token can reach.
type Provider struct {
	token  string
	base   string
	client *http.Client
	mu     sync.Mutex // read-modify-write of RRsets
}

// New builds the adapter from the catalog fields (bearer_token).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	token := fields["bearer_token"]
	if !tokenPattern.MatchString(token) {
		return nil, fmt.Errorf("%w: Gandi bearer_token is malformed", dnsx.ErrInvalid)
	}
	return &Provider{token: token, base: opts.Endpoint(endpoint), client: opts.Client()}, nil
}

type rrset struct {
	Name   string   `json:"rrset_name,omitempty"`
	Type   string   `json:"rrset_type,omitempty"`
	TTL    int      `json:"rrset_ttl,omitempty"`
	Values []string `json:"rrset_values"`
}

type apiErr struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Cause   string `json:"cause"`
	Errors  []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	} `json:"errors"`
}

func describe(raw []byte) string {
	var e apiErr
	if json.Unmarshal(raw, &e) != nil {
		return ""
	}
	text := strings.TrimSpace(e.Cause + " " + e.Message)
	for _, d := range e.Errors {
		text += "; " + d.Name + ": " + d.Description
	}
	return text
}

func (p *Provider) header() http.Header {
	return http.Header{"Authorization": {"Bearer " + p.token}, "User-Agent": {userAgent}}
}

func (p *Provider) do(ctx context.Context, method, path string, in, out any) error {
	return p.send(ctx, p.client, method, p.base+path, in, out)
}

func (p *Provider) send(ctx context.Context, client *http.Client, method, target string, in, out any) error {
	err := dnsx.JSON(ctx, client, method, target, p.header(), in, out, describe)
	var status *dnsx.StatusError
	if errors.As(err, &status) {
		return fmt.Errorf("%w: Gandi %w", status.Kind(), err)
	}
	return err
}

// page fetches one page of a list and its Total-Count header (-1 when
// absent).
func (p *Provider) page(ctx context.Context, path string, n int, out any) (int, error) {
	var header http.Header
	client := *p.client
	next := client.Transport
	if next == nil {
		next = http.DefaultTransport
	}
	client.Transport = capture{next: next, header: &header}
	query := url.Values{"page": {strconv.Itoa(n)}, "per_page": {strconv.Itoa(perPage)}}
	if err := p.send(ctx, &client, http.MethodGet, p.base+path+"?"+query.Encode(), nil, out); err != nil {
		return 0, err
	}
	if total, err := strconv.Atoi(header.Get("Total-Count")); err == nil {
		return total, nil
	}
	return -1, nil
}

// capture keeps the response headers, which dnsx.JSON does not return.
type capture struct {
	next   http.RoundTripper
	header *http.Header
}

func (c capture) RoundTrip(req *http.Request) (*http.Response, error) {
	res, err := c.next.RoundTrip(req)
	if err == nil {
		*c.header = res.Header
	}
	return res, err
}

// pages collects every item of a paginated list.
func pages[T any](ctx context.Context, p *Provider, path string) ([]T, error) {
	var all []T
	for n := 1; ; n++ {
		var chunk []T
		total, err := p.page(ctx, path, n, &chunk)
		if err != nil {
			return nil, err
		}
		all = append(all, chunk...)
		if len(all) > maxRecords {
			return nil, fmt.Errorf("%w: Gandi list exceeds %d items", dnsx.ErrProvider, maxRecords)
		}
		done := len(chunk) == 0 || (total >= 0 && len(all) >= total) || (total < 0 && len(chunk) < perPage)
		if done {
			return all, nil
		}
	}
}

func domainPath(zone string) string { return "/domains/" + url.PathEscape(dnsx.Zone(zone)) }

func setPath(zone, name, typ string) string {
	return domainPath(zone) + "/records/" + url.PathEscape(strings.ToLower(name)) + "/" + url.PathEscape(strings.ToUpper(typ))
}

// value is the zone-file form LiveDNS stores: host targets absolute (a
// name without the trailing dot is relative to the zone), TXT quoted in
// strings of at most 255 bytes.
func value(r libdns.RR) string {
	switch strings.ToUpper(r.Type) {
	case "CNAME", "ALIAS":
		if !strings.HasSuffix(r.Data, ".") {
			return r.Data + "."
		}
	case "TXT":
		return quote(r.Data)
	}
	return r.Data
}

func quote(text string) string {
	var parts []string
	for {
		chunk := text
		if len(chunk) > 255 {
			chunk = chunk[:255]
		}
		text = text[len(chunk):]
		parts = append(parts, `"`+strings.ReplaceAll(strings.ReplaceAll(chunk, `\`, `\\`), `"`, `\"`)+`"`)
		if text == "" {
			return strings.Join(parts, " ")
		}
	}
}

func ttl(r libdns.RR) int { return min(max(dnsx.Seconds(r.TTL), minTTL), maxTTL) }

func members(set rrset) []libdns.RR {
	out := make([]libdns.RR, 0, len(set.Values))
	for _, v := range set.Values {
		if set.Type == "TXT" {
			v = dnsx.Unquote(v)
		}
		out = append(out, dnsx.RR(strings.ToLower(set.Name), set.Type, v, set.TTL))
	}
	return out
}

// sets groups records by (name, type) in input order.
func sets(records []libdns.RR) [][]libdns.RR {
	index := map[string]int{}
	var out [][]libdns.RR
	for _, r := range records {
		key := dnsx.SetKey(r)
		i, ok := index[key]
		if !ok {
			i = len(out)
			index[key] = i
			out = append(out, nil)
		}
		out[i] = append(out[i], r)
	}
	return out
}

// current reads one RRset; absent is not an error.
func (p *Provider) current(ctx context.Context, zone, name, typ string) (*rrset, error) {
	var set rrset
	err := p.do(ctx, http.MethodGet, setPath(zone, name, typ), nil, &set)
	var status *dnsx.StatusError
	if errors.As(err, &status) && status.Status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	set.Type = strings.ToUpper(typ)
	set.Name = strings.ToLower(name)
	return &set, nil
}

func (p *Provider) put(ctx context.Context, zone, name, typ string, values []string, ttl int) error {
	return p.do(ctx, http.MethodPut, setPath(zone, name, typ), rrset{Values: values, TTL: ttl}, nil)
}

// GetRecords lists every record of the zone.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	all, err := pages[rrset](ctx, p, domainPath(zone)+"/records")
	if err != nil {
		return nil, err
	}
	var out []libdns.Record
	for _, set := range all {
		for _, r := range members(set) {
			out = append(out, r)
		}
	}
	return out, nil
}

// AppendRecords adds the records to their RRsets. An RRset has one TTL:
// an existing RRset keeps its TTL, a new one takes the input TTL.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var done []libdns.Record
	for _, set := range sets(dnsx.RRs(records)) {
		name, typ := set[0].Name, set[0].Type
		old, err := p.current(ctx, zone, name, typ)
		if err != nil {
			return done, err
		}
		var values []string
		have := map[string]bool{}
		setTTL := ttl(set[0])
		if old != nil {
			values = old.Values
			for _, r := range members(*old) {
				have[dnsx.Key(r)] = true
			}
			if old.TTL > 0 {
				setTTL = old.TTL
			}
		}
		for _, r := range set {
			if !have[dnsx.Key(r)] {
				have[dnsx.Key(r)] = true
				values = append(values, value(r))
			}
		}
		if err := p.put(ctx, zone, name, typ, values, setTTL); err != nil {
			return done, err
		}
		for _, r := range set {
			done = append(done, dnsx.RR(r.Name, r.Type, r.Data, setTTL))
		}
	}
	return done, nil
}

// SetRecords replaces each input RRset with the input records (one PUT per
// RRset; the RRset takes the largest input TTL).
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, set := range sets(dnsx.RRs(records)) {
		var values []string
		seen := map[string]bool{}
		setTTL := 0
		for _, r := range set {
			setTTL = max(setTTL, ttl(r))
			if !seen[dnsx.Key(r)] {
				seen[dnsx.Key(r)] = true
				values = append(values, value(r))
			}
		}
		if err := p.put(ctx, zone, set[0].Name, set[0].Type, values, setTTL); err != nil {
			return nil, err
		}
	}
	return records, nil
}

// DeleteRecords removes the matching values (data empty: the whole RRset);
// an RRset left empty is deleted.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var deleted []libdns.Record
	for _, set := range sets(dnsx.RRs(records)) {
		name, typ := set[0].Name, set[0].Type
		old, err := p.current(ctx, zone, name, typ)
		if err != nil {
			return deleted, err
		}
		if old == nil {
			continue
		}
		var keep []string
		var gone []libdns.Record
		for i, r := range members(*old) {
			if slices.ContainsFunc(set, func(in libdns.RR) bool { return dnsx.Matches(r, in) }) {
				gone = append(gone, r)
			} else {
				keep = append(keep, old.Values[i])
			}
		}
		switch {
		case len(gone) == 0:
			continue
		case len(keep) == 0:
			err = p.do(ctx, http.MethodDelete, setPath(zone, name, typ), nil, nil)
		default:
			err = p.put(ctx, zone, name, typ, keep, old.TTL)
		}
		if err != nil {
			return deleted, err
		}
		deleted = append(deleted, gone...)
	}
	return deleted, nil
}

// ListZones lists the LiveDNS domains of the token's organization.
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	domains, err := pages[struct {
		FQDN string `json:"fqdn"`
	}](ctx, p, "/domains")
	if err != nil {
		return nil, err
	}
	zones := make([]libdns.Zone, 0, len(domains))
	for _, d := range domains {
		zones = append(zones, libdns.Zone{Name: dnsx.Zone(d.FQDN) + "."})
	}
	return zones, nil
}
