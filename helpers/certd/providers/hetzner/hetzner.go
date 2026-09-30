// Package hetzner is the Hetzner DNS adapter for the zones of the Hetzner
// Cloud API (https://docs.hetzner.cloud/reference/cloud#zones): bearer
// project token, zones addressed by name, RRset-based writes that return
// asynchronous actions. The DNS Console API (dns.hetzner.com/api/v1), which
// the published libdns module targets, was shut down in May 2026.
package hetzner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	endpoint   = "https://api.hetzner.cloud"
	userAgent  = "edgeweir-certd/1"
	perPage    = 100 // maximum for rrsets
	maxRecords = 100000
	minTTL     = 60 // "Must be in between 60s and 2147483647s."
	maxBatch   = 50 // records per set/add/remove action
	maxWait    = 2 * time.Minute
	retries    = 5 // attempts while the zone is locked by another action
)

// Provider talks to the zones of one Hetzner Console project.
type Provider struct {
	token  string
	base   string
	client *http.Client
	mu     sync.Mutex // actions on one zone run one at a time
	// sleep waits between action polls and retries (tests replace it).
	sleep func(context.Context, time.Duration) error
}

// New builds the adapter from the catalog fields (api_token).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	token := fields["api_token"]
	if !validToken(token) {
		return nil, fmt.Errorf("%w: Hetzner api_token is malformed", dnsx.ErrInvalid)
	}
	return &Provider{token: token, base: opts.Endpoint(endpoint), client: opts.Client(), sleep: sleep}, nil
}

// validToken accepts printable ASCII without spaces (project tokens are 64
// letters and digits).
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

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type value struct {
	Value string `json:"value"`
}

type rrset struct {
	Name    string  `json:"name"`
	Type    string  `json:"type"`
	TTL     *int    `json:"ttl"`
	Records []value `json:"records"`
	ttl     int     // effective TTL (zone default when TTL is null)
}

type action struct {
	ID      int64  `json:"id"`
	Command string `json:"command"`
	Status  string `json:"status"`
	Error   *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// apiError is a non-2xx answer ({"error":{"code","message"}}).
type apiError struct {
	kind    error
	status  int
	code    string
	message string
}

func (e *apiError) Error() string {
	return fmt.Sprintf("HTTP %d %s: %s", e.status, e.code, e.message)
}

func (e *apiError) Unwrap() error { return e.kind }

// classify maps the documented error codes to kinds.
func classify(status int, raw []byte) error {
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &body)
	e := &apiError{status: status, code: body.Error.Code, message: dnsx.Short(body.Error.Message)}
	switch e.code {
	case "unauthorized", "token_readonly", "forbidden":
		e.kind = dnsx.ErrAuth
	case "not_found":
		e.kind = dnsx.ErrZoneNotFound
	case "rate_limit_exceeded":
		e.kind = dnsx.ErrRateLimited
	case "maintenance", "unavailable", "timeout", "server_error", "bad_gateway":
		e.kind = dnsx.ErrUnreachable
	case "incorrect_zone_mode":
		e.kind = dnsx.ErrUnsupported // secondary zone: records come from AXFR
	case "invalid_input", "json_error":
		e.kind = dnsx.ErrInvalid
	default:
		e.kind = (&dnsx.StatusError{Status: status}).Kind()
	}
	return e
}

func (p *Provider) call(ctx context.Context, method, path string, query url.Values, in, out any) error {
	target := p.base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return fmt.Errorf("%w: encoding request", dnsx.ErrInvalid)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	req.Header.Set("Authorization", "Bearer "+p.token)
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	status, raw, err := dnsx.Do(p.client, req)
	if err != nil {
		return err
	}
	if status < 200 || status > 299 {
		return classify(status, raw)
	}
	if out == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if json.Unmarshal(raw, out) != nil {
		return fmt.Errorf("%w: invalid Hetzner response", dnsx.ErrProvider)
	}
	return nil
}

// mutate starts an action (retrying while the zone is locked by a running
// action) and waits for it.
func (p *Provider) mutate(ctx context.Context, method, path string, in any) error {
	delay := time.Second
	for attempt := 1; ; attempt++ {
		var res struct {
			Action action `json:"action"`
		}
		err := p.call(ctx, method, path, nil, in, &res)
		var api *apiError
		if err != nil && errors.As(err, &api) && (api.code == "locked" || api.code == "conflict") && attempt < retries {
			if err := p.sleep(ctx, delay); err != nil {
				return err
			}
			delay *= 2
			continue
		}
		if err != nil {
			return err
		}
		return p.wait(ctx, res.Action)
	}
}

// wait polls a running action until it succeeds or fails.
func (p *Provider) wait(ctx context.Context, a action) error {
	delay, waited := 500*time.Millisecond, time.Duration(0)
	for a.Status == "running" {
		if waited >= maxWait {
			return fmt.Errorf("%w: Hetzner action %d still running", dnsx.ErrUnreachable, a.ID)
		}
		if err := p.sleep(ctx, delay); err != nil {
			return err
		}
		waited += delay
		delay = min(delay*2, 5*time.Second)
		var res struct {
			Action action `json:"action"`
		}
		if err := p.call(ctx, http.MethodGet, "/v1/zones/actions/"+strconv.FormatInt(a.ID, 10), nil, nil, &res); err != nil {
			return err
		}
		a = res.Action
	}
	if a.Status == "error" {
		code, message := "", ""
		if a.Error != nil {
			code, message = a.Error.Code, dnsx.Short(a.Error.Message)
		}
		return fmt.Errorf("%w: Hetzner action %s failed: %s %s", dnsx.ErrProvider, a.Command, code, message)
	}
	return nil
}

func zonePath(zone string) (string, error) {
	z := dnsx.Zone(zone)
	if z == "" || strings.ContainsAny(z, "/?#% ") {
		return "", fmt.Errorf("%w: invalid zone %q", dnsx.ErrInvalid, zone)
	}
	return "/v1/zones/" + url.PathEscape(z), nil
}

func rrsetPath(zp, name, typ string) string {
	return zp + "/rrsets/" + url.PathEscape(name) + "/" + url.PathEscape(typ)
}

// list returns every RRset of the zone with its effective TTL.
func (p *Provider) list(ctx context.Context, zp string) ([]rrset, error) {
	var all []rrset
	count, defaults := 0, false
	for page := 1; ; {
		var res struct {
			RRsets []rrset `json:"rrsets"`
			Meta   struct {
				Pagination struct {
					NextPage *int `json:"next_page"`
				} `json:"pagination"`
			} `json:"meta"`
		}
		query := url.Values{"page": {strconv.Itoa(page)}, "per_page": {strconv.Itoa(perPage)}}
		if err := p.call(ctx, http.MethodGet, zp+"/rrsets", query, nil, &res); err != nil {
			return nil, err
		}
		for _, s := range res.RRsets {
			count += len(s.Records)
			defaults = defaults || s.TTL == nil
		}
		if count > maxRecords {
			return nil, fmt.Errorf("%w: Hetzner zone exceeds %d records", dnsx.ErrProvider, maxRecords)
		}
		all = append(all, res.RRsets...)
		next := res.Meta.Pagination.NextPage
		if next == nil || *next <= page || len(res.RRsets) == 0 {
			break
		}
		page = *next
	}
	zoneTTL := 0
	if defaults {
		var res struct {
			Zone struct {
				TTL int `json:"ttl"`
			} `json:"zone"`
		}
		if err := p.call(ctx, http.MethodGet, zp, nil, nil, &res); err != nil {
			return nil, err
		}
		zoneTTL = res.Zone.TTL
	}
	for i := range all {
		all[i].Name = strings.ToLower(all[i].Name)
		all[i].Type = strings.ToUpper(all[i].Type)
		all[i].ttl = zoneTTL
		if all[i].TTL != nil {
			all[i].ttl = *all[i].TTL
		}
	}
	return all, nil
}

// rr converts one record value; TXT values are quoted character strings.
func rr(s rrset, v value) libdns.RR {
	data := v.Value
	if s.Type == "TXT" {
		data = dnsx.Unquote(data)
	}
	return dnsx.RR(s.Name, s.Type, data, s.ttl)
}

// format turns input data into the value the API expects: TXT as quoted
// strings of at most 255 bytes, CNAME as an absolute name (without the
// trailing dot the zone would be appended).
func format(r libdns.RR) string {
	switch r.Type {
	case "TXT":
		return quote(r.Data)
	case "CNAME":
		return strings.TrimSuffix(r.Data, ".") + "."
	}
	return r.Data
}

func quote(text string) string {
	if text == "" {
		return `""`
	}
	var parts []string
	for len(text) > 0 {
		n := min(len(text), 255)
		chunk := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(text[:n])
		parts = append(parts, `"`+chunk+`"`)
		text = text[n:]
	}
	return strings.Join(parts, " ")
}

func ttlOf(r libdns.RR) int { return max(dnsx.Seconds(r.TTL), minTTL) }

// groups normalizes the input and groups it by RRset, in input order.
func groups(records []libdns.Record, zone string) ([]string, map[string][]libdns.RR) {
	var order []string
	byKey := map[string][]libdns.RR{}
	for _, r := range dnsx.RRs(records) {
		r = dnsx.RR(dnsx.Relative(r.Name, zone), r.Type, r.Data, ttlOf(r))
		key := dnsx.SetKey(r)
		if _, ok := byKey[key]; !ok {
			order = append(order, key)
		}
		byKey[key] = append(byKey[key], r)
	}
	return order, byKey
}

func index(sets []rrset) map[string]*rrset {
	out := map[string]*rrset{}
	for i := range sets {
		out[sets[i].Name+"\x00"+sets[i].Type] = &sets[i]
	}
	return out
}

// GetRecords lists every record of the zone.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	zp, err := zonePath(zone)
	if err != nil {
		return nil, err
	}
	sets, err := p.list(ctx, zp)
	if err != nil {
		return nil, err
	}
	var out []libdns.Record
	for _, s := range sets {
		for _, v := range s.Records {
			out = append(out, rr(s, v))
		}
	}
	return out, nil
}

// AppendRecords adds the records to their RRsets (created when missing).
// An existing RRset keeps its TTL.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	zp, err := zonePath(zone)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	sets, err := p.list(ctx, zp)
	if err != nil {
		return nil, err
	}
	current := index(sets)
	order, byKey := groups(records, zone)
	var done []libdns.Record
	for _, key := range order {
		group := byKey[key]
		old := current[key]
		ttl := ttlOf(group[0])
		present := map[string]bool{}
		if old != nil {
			ttl = old.ttl
			for _, v := range old.Records {
				present[dnsx.Key(rr(*old, v))] = true
			}
		}
		var values []value
		var added []libdns.Record
		for _, r := range group {
			r.TTL = time.Duration(ttl) * time.Second
			if present[dnsx.Key(r)] {
				continue
			}
			present[dnsx.Key(r)] = true
			values = append(values, value{format(r)})
			added = append(added, r)
		}
		for start := 0; start < len(values); start += maxBatch {
			req := map[string]any{"records": values[start:min(start+maxBatch, len(values))]}
			if old == nil && start == 0 {
				req["ttl"] = ttl // creates the RRset; later batches add to it
			}
			if err := p.mutate(ctx, http.MethodPost, rrsetPath(zp, group[0].Name, group[0].Type)+"/actions/add_records", req); err != nil {
				return done, err
			}
		}
		done = append(done, added...)
	}
	return done, nil
}

// SetRecords makes each input RRset exactly the input records: a missing
// RRset is created, an existing one gets its records set (members already
// present keep their stored value) and its TTL changed when they differ.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	zp, err := zonePath(zone)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	sets, err := p.list(ctx, zp)
	if err != nil {
		return nil, err
	}
	current := index(sets)
	order, byKey := groups(records, zone)
	var out []libdns.Record
	for _, key := range order {
		group := byKey[key]
		ttl := ttlOf(group[0])
		stored := map[string]string{}
		old := current[key]
		if old != nil {
			for _, v := range old.Records {
				stored[dnsx.Key(rr(*old, v))] = v.Value
			}
		}
		var values []value
		seen := map[string]bool{}
		for _, r := range group {
			r.TTL = time.Duration(ttl) * time.Second
			k := dnsx.Key(r)
			if seen[k] {
				continue
			}
			seen[k] = true
			v, ok := stored[k]
			if !ok {
				v = format(r)
			}
			values = append(values, value{v})
			out = append(out, r)
		}
		if len(values) > maxBatch {
			return out, fmt.Errorf("%w: Hetzner RRsets hold at most %d records per change", dnsx.ErrInvalid, maxBatch)
		}
		name, typ := group[0].Name, group[0].Type
		if old == nil {
			req := map[string]any{"name": name, "type": typ, "ttl": ttl, "records": values}
			if err := p.mutate(ctx, http.MethodPost, zp+"/rrsets", req); err != nil {
				return out, err
			}
			continue
		}
		// Compare with the stored values themselves: two stored values with the
		// same canonical form must still collapse to the input.
		if len(old.Records) != len(seen) || !subset(seen, stored) {
			if err := p.mutate(ctx, http.MethodPost, rrsetPath(zp, name, typ)+"/actions/set_records", map[string]any{"records": values}); err != nil {
				return out, err
			}
		}
		if old.ttl != ttl {
			if err := p.mutate(ctx, http.MethodPost, rrsetPath(zp, name, typ)+"/actions/change_ttl", map[string]any{"ttl": ttl}); err != nil {
				return out, err
			}
		}
	}
	return out, nil
}

func subset(keys map[string]bool, stored map[string]string) bool {
	for k := range keys {
		if _, ok := stored[k]; !ok {
			return false
		}
	}
	return true
}

// DeleteRecords removes the matching records (data empty: the whole RRset).
// An RRset losing all its records is deleted.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	zp, err := zonePath(zone)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	sets, err := p.list(ctx, zp)
	if err != nil {
		return nil, err
	}
	input := dnsx.RRs(records)
	for i := range input {
		input[i].Name = dnsx.Relative(input[i].Name, zone)
	}
	var deleted []libdns.Record
	for _, s := range sets {
		var matched []value
		var gone []libdns.Record
		for _, v := range s.Records {
			record := rr(s, v)
			for _, in := range input {
				if dnsx.Matches(record, in) {
					matched = append(matched, v)
					gone = append(gone, record)
					break
				}
			}
		}
		if len(matched) == 0 {
			continue
		}
		path := rrsetPath(zp, s.Name, s.Type)
		if len(matched) == len(s.Records) {
			err = p.mutate(ctx, http.MethodDelete, path, nil)
		} else {
			for start := 0; start < len(matched) && err == nil; start += maxBatch {
				batch := matched[start:min(start+maxBatch, len(matched))]
				err = p.mutate(ctx, http.MethodPost, path+"/actions/remove_records", map[string]any{"records": batch})
			}
		}
		if err != nil {
			return deleted, err
		}
		deleted = append(deleted, gone...)
	}
	return deleted, nil
}

// ListZones lists the project's primary zones (secondary zones take their
// records from AXFR and cannot be edited).
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var zones []libdns.Zone
	for page := 1; ; {
		var res struct {
			Zones []struct {
				Name string `json:"name"`
			} `json:"zones"`
			Meta struct {
				Pagination struct {
					NextPage *int `json:"next_page"`
				} `json:"pagination"`
			} `json:"meta"`
		}
		query := url.Values{"mode": {"primary"}, "page": {strconv.Itoa(page)}, "per_page": {"50"}}
		if err := p.call(ctx, http.MethodGet, "/v1/zones", query, nil, &res); err != nil {
			return nil, err
		}
		for _, z := range res.Zones {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(z.Name) + "."})
		}
		next := res.Meta.Pagination.NextPage
		if next == nil || *next <= page || len(res.Zones) == 0 || len(zones) > maxRecords {
			return zones, nil
		}
		page = *next
	}
}
