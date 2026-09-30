// Package godaddy is the GoDaddy adapter for the Domains v1 API
// (https://developer.godaddy.com/docs/references/rest/domains/v1): a classic
// developer key "key:secret" (Authorization: sso-key) or a personal access
// token (Bearer); RRset writes through PUT/DELETE /records/{type}/{name}.
// The libdns module (v1.1.0) is not used: its AppendRecords replaces the
// RRset, its DeleteRecords ignores record data, it ignores the context and
// logs every call.
package godaddy

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
	endpoint    = "https://api.godaddy.com"
	userAgent   = "edgeweir-certd/1"
	recordsPage = 500 // records per GET
	domainsPage = 500
	maxRecords  = 100000
	minTTL      = 600
)

var (
	keyPattern = regexp.MustCompile(`^[A-Za-z0-9_]{8,128}:[A-Za-z0-9_]{8,128}$`)
	patPattern = regexp.MustCompile(`^[A-Za-z0-9_.~+/=-]+$`)
)

// Provider talks to one GoDaddy account.
type Provider struct {
	auth   string // Authorization header value
	base   string
	client *http.Client
	mu     sync.Mutex // read-modify-write of RRsets
}

// New builds the adapter from the catalog fields (api_token: "key:secret"
// or a personal access token).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	token := fields["api_token"]
	var auth string
	switch {
	case keyPattern.MatchString(token):
		auth = "sso-key " + token
	case len(token) >= 16 && len(token) <= 4096 && patPattern.MatchString(token):
		auth = "Bearer " + token
	default:
		return nil, fmt.Errorf("%w: GoDaddy api_token must be \"key:secret\" or a personal access token", dnsx.ErrInvalid)
	}
	return &Provider{auth: auth, base: opts.Endpoint(endpoint), client: opts.Client()}, nil
}

type record struct {
	Type     string `json:"type,omitempty"`
	Name     string `json:"name,omitempty"`
	Data     string `json:"data"`
	TTL      int    `json:"ttl"`
	Priority *int   `json:"priority,omitempty"`
}

func describe(raw []byte) string {
	var e struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Fields  []struct {
			Path    string `json:"path"`
			Message string `json:"message"`
		} `json:"fields"`
	}
	if json.Unmarshal(raw, &e) != nil {
		return ""
	}
	text := strings.TrimSpace(e.Code + " " + e.Message)
	for _, f := range e.Fields {
		text += "; " + f.Path + ": " + f.Message
	}
	return text
}

func (p *Provider) do(ctx context.Context, method, path string, query url.Values, in, out any) error {
	target := p.base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	header := http.Header{"Authorization": {p.auth}, "User-Agent": {userAgent}}
	err := dnsx.JSON(ctx, p.client, method, target, header, in, out, describe)
	var status *dnsx.StatusError
	if errors.As(err, &status) {
		// 401 UNABLE_TO_AUTHENTICATE, 403 missing scope or ineligible account,
		// 404 domain unknown or not in this account.
		return fmt.Errorf("%w: GoDaddy %w", status.Kind(), err)
	}
	return err
}

func domainPath(zone string) string { return "/v1/domains/" + url.PathEscape(dnsx.Zone(zone)) }

func setPath(zone, name, typ string) string {
	return domainPath(zone) + "/records/" + url.PathEscape(strings.ToUpper(typ)) + "/" + url.PathEscape(strings.ToLower(name))
}

func toRR(r record) libdns.RR {
	data := r.Data
	switch r.Type {
	case "TXT":
		data = dnsx.Unquote(data)
	case "MX", "SRV":
		if r.Priority != nil {
			data = strconv.Itoa(*r.Priority) + " " + data
		}
	}
	return dnsx.RR(strings.ToLower(r.Name), r.Type, data, r.TTL)
}

func ttl(r libdns.RR) int { return max(dnsx.Seconds(r.TTL), minTTL) }

// data is GoDaddy's value form: hostnames without the trailing dot.
func data(r libdns.RR) string {
	if strings.EqualFold(r.Type, "CNAME") {
		return strings.TrimSuffix(r.Data, ".")
	}
	return r.Data
}

func check(records []libdns.RR) error {
	for _, r := range records {
		if strings.EqualFold(r.Type, "CNAME") && r.Name == "@" {
			return fmt.Errorf("%w: GoDaddy does not allow a CNAME at the zone apex", dnsx.ErrUnsupported)
		}
	}
	return nil
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

// GetRecords lists every record of the zone. The first page is read without
// offset; further pages pass offset as a 1-based page number, as the API
// serves it (the reference calls it a number of results to skip).
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	var out []libdns.Record
	for page := 1; ; page++ {
		query := url.Values{"limit": {strconv.Itoa(recordsPage)}}
		if page > 1 {
			query.Set("offset", strconv.Itoa(page))
		}
		var chunk []record
		err := p.do(ctx, http.MethodGet, domainPath(zone)+"/records", query, nil, &chunk)
		var status *dnsx.StatusError
		if page > 1 && errors.As(err, &status) && status.Status == http.StatusUnprocessableEntity {
			return out, nil // past the last page
		}
		if err != nil {
			return nil, err
		}
		for _, r := range chunk {
			out = append(out, toRR(r))
		}
		if len(out) > maxRecords {
			return nil, fmt.Errorf("%w: GoDaddy zone exceeds %d records", dnsx.ErrProvider, maxRecords)
		}
		if len(chunk) < recordsPage {
			return out, nil
		}
	}
}

// AppendRecords adds the records with one PATCH.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	input := dnsx.RRs(records)
	if err := check(input); err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	body := make([]record, 0, len(input))
	var done []libdns.Record
	for _, r := range input {
		body = append(body, record{Type: strings.ToUpper(r.Type), Name: strings.ToLower(r.Name), Data: data(r), TTL: ttl(r)})
		done = append(done, dnsx.RR(r.Name, r.Type, r.Data, ttl(r)))
	}
	if len(body) == 0 {
		return nil, nil
	}
	if err := p.do(ctx, http.MethodPatch, domainPath(zone)+"/records", nil, body, nil); err != nil {
		return nil, err
	}
	return done, nil
}

// SetRecords replaces each input RRset with one PUT.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	input := dnsx.RRs(records)
	if err := check(input); err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, set := range sets(input) {
		var body []record
		seen := map[string]bool{}
		for _, r := range set {
			if !seen[dnsx.Key(r)] {
				seen[dnsx.Key(r)] = true
				body = append(body, record{Data: data(r), TTL: ttl(r)})
			}
		}
		if err := p.do(ctx, http.MethodPut, setPath(zone, set[0].Name, set[0].Type), nil, body, nil); err != nil {
			return nil, err
		}
	}
	return records, nil
}

// DeleteRecords removes the matching records (data empty: the whole RRset):
// the rest of the RRset is written back, an emptied RRset is deleted.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var deleted []libdns.Record
	for _, set := range sets(dnsx.RRs(records)) {
		name, typ := set[0].Name, set[0].Type
		var existing []record
		if err := p.do(ctx, http.MethodGet, setPath(zone, name, typ), nil, nil, &existing); err != nil {
			return deleted, err
		}
		var keep []record
		var gone []libdns.Record
		for _, old := range existing {
			rr := toRR(old)
			if slices.ContainsFunc(set, func(in libdns.RR) bool { return dnsx.Matches(rr, in) }) {
				gone = append(gone, rr)
			} else {
				keep = append(keep, record{Data: old.Data, TTL: old.TTL, Priority: old.Priority})
			}
		}
		var err error
		switch {
		case len(gone) == 0:
			continue
		case len(keep) == 0:
			err = p.do(ctx, http.MethodDelete, setPath(zone, name, typ), nil, nil, nil)
		default:
			err = p.do(ctx, http.MethodPut, setPath(zone, name, typ), nil, keep, nil)
		}
		if err != nil {
			return deleted, err
		}
		deleted = append(deleted, gone...)
	}
	return deleted, nil
}

// ListZones lists the account's domains (cursor: the last domain name).
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var zones []libdns.Zone
	marker := ""
	for len(zones) <= maxRecords {
		query := url.Values{"limit": {strconv.Itoa(domainsPage)}}
		if marker != "" {
			query.Set("marker", marker)
		}
		var chunk []struct {
			Domain string `json:"domain"`
		}
		if err := p.do(ctx, http.MethodGet, "/v1/domains", query, nil, &chunk); err != nil {
			return nil, err
		}
		for _, d := range chunk {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(d.Domain) + "."})
		}
		if len(chunk) < domainsPage || chunk[len(chunk)-1].Domain == marker {
			break
		}
		marker = chunk[len(chunk)-1].Domain
	}
	return zones, nil
}
