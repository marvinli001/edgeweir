// Package cloudflare is the Cloudflare adapter for the v4 API
// (https://developers.cloudflare.com/api/): bearer API tokens, zones looked
// up by name, every write sent through the batch endpoint so that one call
// applies in one transaction. The libdns module (v0.2.2) is not used: its
// SetRecords fails on RRsets with more than one member and never removes
// extra members, its DeleteRecords cannot remove a whole RRset, and its
// ListZones reads only the first page.
package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	endpoint     = "https://api.cloudflare.com/client/v4"
	userAgent    = "edgeweir-certd/1"
	perPage      = 5000 // dns_records allows far more; keeps responses bounded
	zonesPerPage = 50   // maximum for /zones
	maxRecords   = 100000
	minTTL       = 60 // 30 only on Enterprise zones
	maxTTL       = 86400
	autoTTL      = 300 // what ttl=1 ("automatic") serves for DNS-only records
)

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{20,256}$`)

// Provider talks to one Cloudflare account.
type Provider struct {
	token     string // Zone.DNS Edit (plus Zone.Zone Read without zoneToken)
	zoneToken string // optional Zone.Zone Read for zone lookups and listing
	base      string
	client    *http.Client
	mu        sync.Mutex // serializes read-modify-write per provider
	zoneMu    sync.Mutex
	zones     map[string]string // zone name -> zone ID
}

// New builds the adapter from the catalog fields (api_token, zone_token).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	token, zoneToken := fields["api_token"], fields["zone_token"]
	if !tokenPattern.MatchString(token) {
		return nil, fmt.Errorf("%w: Cloudflare api_token is not an API token", dnsx.ErrInvalid)
	}
	if zoneToken != "" && !tokenPattern.MatchString(zoneToken) {
		return nil, fmt.Errorf("%w: Cloudflare zone_token is not an API token", dnsx.ErrInvalid)
	}
	return &Provider{token: token, zoneToken: zoneToken, base: opts.Endpoint(endpoint), client: opts.Client(), zones: map[string]string{}}, nil
}

type apiMessage struct {
	Code       int          `json:"code"`
	Message    string       `json:"message"`
	ErrorChain []apiMessage `json:"error_chain"`
}

type resultInfo struct {
	Page       int `json:"page"`
	TotalPages int `json:"total_pages"`
}

type envelope struct {
	Success    bool            `json:"success"`
	Errors     []apiMessage    `json:"errors"`
	Result     json.RawMessage `json:"result"`
	ResultInfo *resultInfo     `json:"result_info"`
}

// authCodes are Cloudflare error codes for a missing, malformed, invalid or
// insufficient token (6003/6111 invalid Authorization header, 9109 invalid
// access token, 10000 authentication error).
var authCodes = map[int]bool{6003: true, 6111: true, 9109: true, 10000: true}

func apiError(status int, errs []apiMessage) error {
	kind := dnsx.ErrProvider
	if status < 200 || status > 299 {
		kind = (&dnsx.StatusError{Status: status}).Kind()
	}
	var check func([]apiMessage)
	check = func(list []apiMessage) {
		for _, e := range list {
			if authCodes[e.Code] {
				kind = dnsx.ErrAuth
			}
			check(e.ErrorChain)
		}
	}
	check(errs)
	text := ""
	if len(errs) > 0 {
		text = fmt.Sprintf(" %d %s", errs[0].Code, dnsx.Short(errs[0].Message))
	}
	return fmt.Errorf("%w: Cloudflare HTTP %d%s", kind, status, text)
}

func (p *Provider) call(ctx context.Context, token, method, path string, query url.Values, in, out any) (*resultInfo, error) {
	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return nil, fmt.Errorf("%w: encoding request", dnsx.ErrInvalid)
		}
		body = bytes.NewReader(raw)
	}
	target := p.base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	status, raw, err := dnsx.Do(p.client, req)
	if err != nil {
		return nil, err
	}
	var env envelope
	if json.Unmarshal(raw, &env) != nil {
		if status < 200 || status > 299 {
			return nil, apiError(status, nil)
		}
		return nil, fmt.Errorf("%w: invalid Cloudflare response", dnsx.ErrProvider)
	}
	if status < 200 || status > 299 || !env.Success {
		return nil, apiError(status, env.Errors)
	}
	if out != nil && len(env.Result) > 0 && string(env.Result) != "null" {
		if json.Unmarshal(env.Result, out) != nil {
			return nil, fmt.Errorf("%w: invalid Cloudflare response", dnsx.ErrProvider)
		}
	}
	return env.ResultInfo, nil
}

// readToken is the token for zone lookups and listing.
func (p *Provider) readToken() string {
	if p.zoneToken != "" {
		return p.zoneToken
	}
	return p.token
}

type zoneObj struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

func (p *Provider) zoneID(ctx context.Context, zone string) (string, error) {
	name := dnsx.Zone(zone)
	p.zoneMu.Lock()
	defer p.zoneMu.Unlock()
	if id, ok := p.zones[name]; ok {
		return id, nil
	}
	var zones []zoneObj
	if _, err := p.call(ctx, p.readToken(), http.MethodGet, "/zones", url.Values{"name": {name}, "per_page": {strconv.Itoa(zonesPerPage)}}, nil, &zones); err != nil {
		return "", err
	}
	id := ""
	for _, z := range zones {
		// The same name can exist in two accounts (one pending); prefer the active zone.
		if strings.EqualFold(z.Name, name) && (id == "" || z.Status == "active") {
			id = z.ID
		}
	}
	if id == "" {
		return "", fmt.Errorf("%w: Cloudflare has no zone %s for this token", dnsx.ErrZoneNotFound, name)
	}
	p.zones[name] = id
	return id, nil
}

type record struct {
	ID       string `json:"id,omitempty"`
	Type     string `json:"type,omitempty"`
	Name     string `json:"name,omitempty"`
	Content  string `json:"content,omitempty"`
	TTL      int    `json:"ttl,omitempty"`
	Proxied  *bool  `json:"proxied,omitempty"`
	Priority *int   `json:"priority,omitempty"`
}

type batch struct {
	Deletes []record `json:"deletes,omitempty"`
	Patches []record `json:"patches,omitempty"`
	Posts   []record `json:"posts,omitempty"`
}

func (b batch) empty() bool { return len(b.Deletes)+len(b.Patches)+len(b.Posts) == 0 }

func recordsPath(zoneID string) string { return "/zones/" + url.PathEscape(zoneID) + "/dns_records" }

func (p *Provider) list(ctx context.Context, zoneID string) ([]record, error) {
	var all []record
	for page := 1; ; page++ {
		var chunk []record
		info, err := p.call(ctx, p.token, http.MethodGet, recordsPath(zoneID), url.Values{"page": {strconv.Itoa(page)}, "per_page": {strconv.Itoa(perPage)}}, nil, &chunk)
		if err != nil {
			return nil, err
		}
		all = append(all, chunk...)
		if len(all) > maxRecords {
			return nil, fmt.Errorf("%w: Cloudflare zone exceeds %d records", dnsx.ErrProvider, maxRecords)
		}
		if len(chunk) == 0 || info == nil || page >= info.TotalPages {
			return all, nil
		}
	}
}

// apply sends one batch; Cloudflare runs deletes, patches, puts, posts in
// that order in one database transaction (no change on any failure).
func (p *Provider) apply(ctx context.Context, zoneID string, ops batch) (batch, error) {
	var result batch
	if ops.empty() {
		return result, nil
	}
	_, err := p.call(ctx, p.token, http.MethodPost, recordsPath(zoneID)+"/batch", nil, ops, &result)
	return result, err
}

func ttl(r libdns.RR) int {
	return min(max(dnsx.Seconds(r.TTL), minTTL), maxTTL)
}

func proxiable(typ string) bool { return typ == "A" || typ == "AAAA" || typ == "CNAME" }

func toRR(zone string, r record) libdns.RR {
	data := r.Content
	switch r.Type {
	case "TXT":
		data = dnsx.Unquote(data)
	case "MX", "SRV":
		if r.Priority != nil {
			data = strconv.Itoa(*r.Priority) + " " + data
		}
	}
	return dnsx.RR(dnsx.Relative(r.Name, zone), r.Type, data, servedTTL(r))
}

func servedTTL(r record) int {
	if r.TTL == 1 {
		return autoTTL
	}
	return r.TTL
}

// quote writes TXT content as one RFC 1035 character string; Cloudflare
// splits strings longer than 255 bytes itself.
func quote(text string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(text, `\`, `\\`), `"`, `\"`) + `"`
}

// post is the create form of an input record. Records are DNS only: a
// proxied record would answer with Cloudflare addresses, not the data.
func post(zone string, r libdns.RR) record {
	out := record{Type: strings.ToUpper(r.Type), Name: strings.ToLower(dnsx.FQDN(r.Name, zone)), Content: r.Data, TTL: ttl(r)}
	switch out.Type {
	case "TXT":
		out.Content = quote(r.Data)
	case "CNAME":
		out.Content = strings.TrimSuffix(r.Data, ".")
	}
	if proxiable(out.Type) {
		out.Proxied = new(bool)
	}
	return out
}

// GetRecords lists every record of the zone.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	zoneID, err := p.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	all, err := p.list(ctx, zoneID)
	if err != nil {
		return nil, err
	}
	out := make([]libdns.Record, 0, len(all))
	for _, r := range all {
		out = append(out, toRR(zone, r))
	}
	return out, nil
}

// AppendRecords creates the records in one batch.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	zoneID, err := p.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	var ops batch
	for _, r := range dnsx.RRs(records) {
		ops.Posts = append(ops.Posts, post(zone, r))
	}
	result, err := p.apply(ctx, zoneID, ops)
	if err != nil {
		return nil, err
	}
	if len(result.Posts) != len(ops.Posts) {
		return records, nil
	}
	out := make([]libdns.Record, 0, len(result.Posts))
	for _, r := range result.Posts {
		out = append(out, toRR(zone, r))
	}
	return out, nil
}

// SetRecords makes each input RRset exactly the input records in one batch:
// matching members stay (TTL rewritten when it differs, proxying turned
// off), extra members are deleted, missing ones created.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	zoneID, err := p.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	existing, err := p.list(ctx, zoneID)
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
	var ops batch
	kept := map[string]bool{}
	for _, old := range existing {
		rr := toRR(zone, old)
		if !sets[dnsx.SetKey(rr)] {
			continue
		}
		key := dnsx.Key(rr)
		if want, ok := wanted[key]; ok && !kept[key] {
			kept[key] = true
			proxied := old.Proxied != nil && *old.Proxied
			if servedTTL(old) != ttl(want) || proxied {
				patch := record{ID: old.ID, TTL: ttl(want)}
				if proxied {
					patch.Proxied = new(bool)
				}
				ops.Patches = append(ops.Patches, patch)
			}
			continue
		}
		ops.Deletes = append(ops.Deletes, record{ID: old.ID})
	}
	for _, r := range input {
		if kept[dnsx.Key(r)] {
			continue
		}
		kept[dnsx.Key(r)] = true
		ops.Posts = append(ops.Posts, post(zone, r))
	}
	if _, err := p.apply(ctx, zoneID, ops); err != nil {
		return nil, err
	}
	return records, nil
}

// DeleteRecords removes the matching records in one batch (data empty: the
// whole RRset).
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	zoneID, err := p.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	existing, err := p.list(ctx, zoneID)
	if err != nil {
		return nil, err
	}
	input := dnsx.RRs(records)
	var ops batch
	var deleted []libdns.Record
	for _, old := range existing {
		rr := toRR(zone, old)
		for _, in := range input {
			if dnsx.Matches(rr, in) {
				ops.Deletes = append(ops.Deletes, record{ID: old.ID})
				deleted = append(deleted, rr)
				break
			}
		}
	}
	if _, err := p.apply(ctx, zoneID, ops); err != nil {
		return nil, err
	}
	return deleted, nil
}

// ListZones lists the zones the token can read.
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var out []libdns.Zone
	for page := 1; page <= maxRecords/zonesPerPage; page++ {
		var zones []zoneObj
		info, err := p.call(ctx, p.readToken(), http.MethodGet, "/zones", url.Values{"page": {strconv.Itoa(page)}, "per_page": {strconv.Itoa(zonesPerPage)}}, nil, &zones)
		if err != nil {
			return nil, err
		}
		for _, z := range zones {
			out = append(out, libdns.Zone{Name: dnsx.Zone(z.Name) + "."})
		}
		if len(zones) == 0 || info == nil || page >= info.TotalPages {
			break
		}
	}
	return out, nil
}
