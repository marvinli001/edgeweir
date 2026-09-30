// Package desec is the deSEC adapter (https://desec.readthedocs.io/): JSON
// over HTTPS with "Authorization: Token <token>", records grouped in RRsets
// (subname, type) that bulk PUT on /rrsets/ creates, replaces or (with no
// records) deletes. Lists are cursor-paginated beyond 500 items; every
// domain has a minimum TTL (3600 s unless deSEC granted an exception).
//
// The published libdns module (github.com/libdns/desec v1.1.1) fails on
// zones with more than 500 RRsets, cannot delete a whole RRset, compares
// record data byte for byte, raises every TTL to 3600 s regardless of the
// domain's minimum, waits out any Retry-After while holding a global lock
// and prints to stdout (certd's protocol channel) on unparsable records, so
// this adapter calls the API directly.
package desec

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const endpoint = "https://desec.io/api/v1"

// Token secrets are URL-safe base64 (28 characters when issued by deSEC).
var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// Rate limits: 429 answers with Retry-After up to maxWait are retried.
const (
	maxWait     = 5 * time.Second
	maxAttempts = 3
)

// Provider talks to one deSEC account.
type Provider struct {
	token   string
	baseURL string
	client  *http.Client
	mu      sync.Mutex // RRset edits are read-modify-write; serialize them
	sleep   func(context.Context, time.Duration) error
}

// New builds the adapter from the catalog fields (token).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	token := fields["token"]
	if !tokenPattern.MatchString(token) {
		return nil, fmt.Errorf("%w: deSEC token must be the token secret", dnsx.ErrInvalid)
	}
	return &Provider{token: token, baseURL: opts.Endpoint(endpoint), client: opts.Client(), sleep: sleep}, nil
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type rrset struct {
	Subname string   `json:"subname"`
	Type    string   `json:"type"`
	TTL     int      `json:"ttl"`
	Records []string `json:"records"`
}

// send is dnsx.Do plus the response header (Link, Retry-After) and the
// Retry-After handling: transport errors never quote the URL, bodies are
// bounded, redirects are not followed (opts.Client).
func (p *Provider) send(ctx context.Context, method, path string, query url.Values, in any, out any) (http.Header, error) {
	var raw []byte
	if in != nil {
		var err error
		if raw, err = json.Marshal(in); err != nil {
			return nil, fmt.Errorf("%w: encoding request", dnsx.ErrInvalid)
		}
	}
	target := p.baseURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	for attempt := 1; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(raw))
		if err != nil {
			return nil, fmt.Errorf("%w: building request", dnsx.ErrInvalid)
		}
		req.Header.Set("Authorization", "Token "+p.token)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "edgeweir-certd/1")
		if in != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		res, err := p.client.Do(req)
		if err != nil {
			var urlErr *url.Error
			if errors.As(err, &urlErr) {
				err = urlErr.Err
			}
			if errors.Is(err, context.Canceled) || errors.Is(err, dnsx.ErrRefused) {
				return nil, err
			}
			return nil, fmt.Errorf("%w: %s", dnsx.ErrUnreachable, dnsx.Short(err.Error()))
		}
		body, err := io.ReadAll(io.LimitReader(res.Body, dnsx.MaxBody+1))
		res.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("%w: reading response", dnsx.ErrUnreachable)
		}
		if len(body) > dnsx.MaxBody {
			return nil, fmt.Errorf("%w: response too large", dnsx.ErrProvider)
		}
		if res.StatusCode == http.StatusTooManyRequests {
			wait, err := strconv.Atoi(strings.TrimSpace(res.Header.Get("Retry-After")))
			if err == nil && wait >= 0 && time.Duration(wait)*time.Second <= maxWait && attempt < maxAttempts {
				if err := p.sleep(ctx, time.Duration(wait)*time.Second); err != nil {
					return nil, err
				}
				continue
			}
			return nil, fmt.Errorf("deSEC %s: %w", method, &dnsx.StatusError{Status: res.StatusCode, Message: "retry after " + res.Header.Get("Retry-After") + " s"})
		}
		if res.StatusCode < 200 || res.StatusCode > 299 {
			return nil, fmt.Errorf("deSEC %s: %w", method, &dnsx.StatusError{Status: res.StatusCode, Message: p.describe(body)})
		}
		if out != nil && len(bytes.TrimSpace(body)) > 0 && json.Unmarshal(body, out) != nil {
			return nil, fmt.Errorf("%w: invalid deSEC response", dnsx.ErrProvider)
		}
		return res.Header, nil
	}
}

// describe flattens deSEC error bodies ({"detail": ...}, {"field": [...]},
// or one object per RRset of a bulk request) into one line.
func (p *Provider) describe(body []byte) string {
	var v any
	if json.Unmarshal(body, &v) != nil {
		return ""
	}
	var texts []string
	var walk func(any)
	walk = func(v any) {
		switch x := v.(type) {
		case string:
			texts = append(texts, x)
		case []any:
			for _, e := range x {
				walk(e)
			}
		case map[string]any:
			for _, e := range x {
				walk(e)
			}
		}
	}
	walk(v)
	return strings.ReplaceAll(dnsx.Short(strings.Join(texts, "; ")), p.token, "***")
}

var nextLink = regexp.MustCompile(`<([^>]*)>\s*;\s*rel="?next"?`)

// nextCursor returns the cursor of the Link header's rel="next" URL. Only
// the cursor is taken: requests stay on the configured endpoint.
func nextCursor(h http.Header) (string, bool) {
	for _, link := range h.Values("Link") {
		if m := nextLink.FindStringSubmatch(link); m != nil {
			u, err := url.Parse(m[1])
			if err != nil {
				return "", false
			}
			return u.Query().Get("cursor"), u.Query().Has("cursor")
		}
	}
	return "", false
}

// pages follows cursor pagination (500 items per page) for a list endpoint.
func pages[T any](ctx context.Context, p *Provider, path string, limit int) ([]T, error) {
	var all []T
	cursor := ""
	for {
		var page []T
		h, err := p.send(ctx, http.MethodGet, path, url.Values{"cursor": {cursor}}, nil, &page)
		if err != nil {
			return nil, err
		}
		all = append(all, page...)
		if len(all) > limit {
			return nil, fmt.Errorf("%w: deSEC list exceeds %d items", dnsx.ErrProvider, limit)
		}
		next, ok := nextCursor(h)
		if !ok || next == "" || len(page) == 0 {
			return all, nil
		}
		cursor = next
	}
}

func domainPath(zone string) string { return "/domains/" + url.PathEscape(dnsx.Zone(zone)) + "/" }

func subname(name string) string {
	if name == "@" {
		return ""
	}
	return strings.ToLower(name)
}

func rrsetPath(zone, sub, typ string) string {
	if sub == "" {
		sub = "@" // deSEC's placeholder for the apex in RRset URLs
	}
	return domainPath(zone) + "rrsets/" + url.PathEscape(sub) + "/" + url.PathEscape(typ) + "/"
}

// fromDesec converts one RRset member to the output form.
func fromDesec(typ, value string) string {
	if typ == "TXT" {
		return unquote(value)
	}
	return value
}

// toDesec converts record data to deSEC's presentation format: CNAME
// targets end with a dot, TXT is quoted and split into 255-byte strings.
func toDesec(r libdns.RR) string {
	switch r.Type {
	case "CNAME":
		if !strings.HasSuffix(r.Data, ".") {
			return r.Data + "."
		}
	case "TXT":
		return quote(dnsx.Unquote(r.Data))
	}
	return r.Data
}

func quote(text string) string {
	var out, chunk strings.Builder
	flush := func() {
		if out.Len() > 0 {
			out.WriteByte(' ')
		}
		out.WriteByte('"')
		out.WriteString(chunk.String())
		out.WriteByte('"')
		chunk.Reset()
	}
	size := 0
	for _, c := range text {
		n := utf8.RuneLen(c)
		if size+n > 255 {
			flush()
			size = 0
		}
		size += n
		switch c {
		case '"', '\\':
			chunk.WriteByte('\\')
		}
		chunk.WriteRune(c)
	}
	if size > 0 || out.Len() == 0 {
		flush()
	}
	return out.String()
}

// unquote decodes zone-file character strings ("a" "b\"c" "\100") and
// concatenates them.
func unquote(value string) string {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, `"`) {
		return value
	}
	var out []byte
	quoted := false
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c == '"':
			quoted = !quoted
		case !quoted:
		case c == '\\' && i+3 < len(value) && isDigit(value[i+1]) && isDigit(value[i+2]) && isDigit(value[i+3]):
			n, _ := strconv.Atoi(value[i+1 : i+4])
			out = append(out, byte(n))
			i += 3
		case c == '\\' && i+1 < len(value):
			i++
			out = append(out, value[i])
		default:
			out = append(out, c)
		}
	}
	return string(out)
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func toRRs(s rrset) []libdns.RR {
	name := s.Subname
	if name == "" {
		name = "@"
	}
	out := make([]libdns.RR, 0, len(s.Records))
	for _, v := range s.Records {
		out = append(out, dnsx.RR(name, s.Type, fromDesec(s.Type, v), s.TTL))
	}
	return out
}

// GetRecords lists every record of the zone.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	sets, err := pages[rrset](ctx, p, domainPath(zone)+"rrsets/", 100000)
	if err != nil {
		return nil, err
	}
	var out []libdns.Record
	for _, s := range sets {
		for _, r := range toRRs(s) {
			out = append(out, r)
		}
	}
	if len(out) > 100000 {
		return nil, fmt.Errorf("%w: deSEC zone exceeds 100000 records", dnsx.ErrProvider)
	}
	return out, nil
}

// minimumTTL reads the domain's minimum TTL (and checks the zone exists).
func (p *Provider) minimumTTL(ctx context.Context, zone string) (int, error) {
	var d struct {
		MinimumTTL int `json:"minimum_ttl"`
	}
	if _, err := p.send(ctx, http.MethodGet, domainPath(zone), nil, nil, &d); err != nil {
		return 0, err
	}
	return d.MinimumTTL, nil
}

// get returns an RRset, or nil when it does not exist.
func (p *Provider) get(ctx context.Context, zone, sub, typ string) (*rrset, error) {
	var s rrset
	_, err := p.send(ctx, http.MethodGet, rrsetPath(zone, sub, typ), nil, nil, &s)
	var status *dnsx.StatusError
	if errors.As(err, &status) && status.Status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (p *Provider) put(ctx context.Context, zone string, sets []rrset) error {
	if len(sets) == 0 {
		return nil
	}
	for i := range sets {
		if sets[i].Records == nil {
			sets[i].Records = []string{} // an empty list deletes the RRset
		}
	}
	_, err := p.send(ctx, http.MethodPut, domainPath(zone)+"rrsets/", nil, sets, nil)
	return err
}

// group splits validated input into RRsets in input order, without
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
			return nil, fmt.Errorf("%w: deSEC adapter writes A, AAAA, CNAME and TXT records", dnsx.ErrUnsupported)
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

// AppendRecords adds the records to their RRsets in one bulk write. An
// existing RRset keeps its TTL; a new one gets the first record's TTL,
// raised to the domain's minimum TTL.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	sets, err := group(records)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	minimum, err := p.minimumTTL(ctx, zone)
	if err != nil {
		return nil, err
	}
	var changed []rrset
	var done []libdns.Record
	for _, in := range sets {
		first := in[0]
		current, err := p.get(ctx, zone, subname(first.Name), first.Type)
		if err != nil {
			return nil, err
		}
		next := rrset{Subname: subname(first.Name), Type: first.Type, TTL: max(dnsx.Seconds(first.TTL), minimum)}
		if current != nil {
			next = *current
		}
		present := map[string]bool{}
		for _, r := range toRRs(next) {
			present[dnsx.Key(r)] = true
		}
		var added []libdns.Record
		for _, r := range in {
			probe := r
			probe.Name = libdnsName(next.Subname)
			if present[dnsx.Key(probe)] {
				continue
			}
			next.Records = append(next.Records, toDesec(r))
			added = append(added, dnsx.RR(r.Name, r.Type, r.Data, next.TTL))
		}
		if len(added) > 0 {
			changed = append(changed, next)
			done = append(done, added...)
		}
	}
	if err := p.put(ctx, zone, changed); err != nil {
		return nil, err
	}
	return done, nil
}

func libdnsName(sub string) string {
	if sub == "" {
		return "@"
	}
	return sub
}

// SetRecords replaces each input RRset with exactly the input records in one
// bulk PUT. The RRset TTL is the first record's, raised to the domain's
// minimum TTL; the returned records carry the TTL actually set.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	sets, err := group(records)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	minimum, err := p.minimumTTL(ctx, zone)
	if err != nil {
		return nil, err
	}
	var body []rrset
	var done []libdns.Record
	for _, in := range sets {
		s := rrset{Subname: subname(in[0].Name), Type: in[0].Type, TTL: max(dnsx.Seconds(in[0].TTL), minimum)}
		for _, r := range in {
			s.Records = append(s.Records, toDesec(r))
			done = append(done, dnsx.RR(r.Name, r.Type, r.Data, s.TTL))
		}
		body = append(body, s)
	}
	if err := p.put(ctx, zone, body); err != nil {
		return nil, err
	}
	return done, nil
}

// DeleteRecords removes the matching members (data empty: the whole RRset)
// in one bulk write and returns them.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var order []string
	inputs := map[string][]libdns.RR{}
	for _, r := range dnsx.RRs(records) {
		r.Type = strings.ToUpper(r.Type)
		key := dnsx.SetKey(r)
		if _, ok := inputs[key]; !ok {
			order = append(order, key)
		}
		inputs[key] = append(inputs[key], r)
	}
	var changed []rrset
	var deleted []libdns.Record
	for _, key := range order {
		in := inputs[key]
		current, err := p.get(ctx, zone, subname(in[0].Name), in[0].Type)
		if err != nil {
			return nil, err
		}
		if current == nil {
			continue
		}
		next := *current
		next.Records = nil
		var gone []libdns.Record
		for i, rr := range toRRs(*current) {
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
				next.Records = append(next.Records, current.Records[i])
			}
		}
		if len(gone) > 0 {
			changed = append(changed, next)
			deleted = append(deleted, gone...)
		}
	}
	if err := p.put(ctx, zone, changed); err != nil {
		return nil, err
	}
	return deleted, nil
}

// ListZones lists the account's domains (for a token with scoping policies,
// only the domains it has a policy for).
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	domains, err := pages[struct {
		Name string `json:"name"`
	}](ctx, p, "/domains/", 100000)
	if err != nil {
		return nil, err
	}
	zones := make([]libdns.Zone, 0, len(domains))
	for _, d := range domains {
		zones = append(zones, libdns.Zone{Name: dnsx.Zone(d.Name) + "."})
	}
	return zones, nil
}
