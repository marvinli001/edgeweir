// Package dnsla is the DNS.LA adapter for its open API
// (https://www.dns.la/docs/ApiDoc): JSON over HTTPS at api.dns.la with HTTP
// Basic authentication (APIID:APISecret). Answers carry a business code
// ({"code":200,"msg":"","data":...}); record types are numeric.
package dnsla

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"unicode"

	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	endpoint   = "https://api.dns.la"
	pageSize   = 100
	maxRecords = 100000
)

// types maps record types to the API's numeric codes ("记录类型").
var types = map[string]int{"A": 1, "NS": 2, "CNAME": 5, "MX": 15, "TXT": 16, "AAAA": 28, "SRV": 33, "CAA": 257}

func typeName(code int) string {
	for name, c := range types {
		if c == code {
			return name
		}
	}
	if code == 256 {
		return "URL" // DNS.LA URL forwarding
	}
	return "TYPE" + strconv.Itoa(code)
}

// Provider talks to one DNS.LA account.
type Provider struct {
	id, secret string
	baseURL    string
	client     *http.Client
	mu         sync.Mutex // serializes read-modify-write per provider
}

func malformed(s string, max int, extra func(rune) bool) bool {
	return s == "" || len(s) > max || strings.ContainsFunc(s, func(r rune) bool {
		return r >= unicode.MaxASCII || !unicode.IsGraphic(r) || unicode.IsSpace(r) || extra(r)
	})
}

// New builds the adapter from the catalog fields (api_id, api_secret).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	id, secret := fields["api_id"], fields["api_secret"]
	if malformed(id, 128, func(r rune) bool { return r == ':' }) {
		return nil, fmt.Errorf("%w: DNS.LA api_id is malformed", dnsx.ErrInvalid)
	}
	if malformed(secret, 256, func(rune) bool { return false }) {
		return nil, fmt.Errorf("%w: DNS.LA api_secret is malformed", dnsx.ErrInvalid)
	}
	return &Provider{id: id, secret: secret, baseURL: opts.Endpoint(endpoint), client: opts.Client()}, nil
}

// apiError is an answer whose business code is not 200.
type apiError struct {
	kind error
	code int
	text string
}

func (e *apiError) Error() string { return e.text }
func (e *apiError) Unwrap() error { return e.kind }

func (p *Provider) scrub(text string) string {
	return strings.NewReplacer(p.id, "[api id]", p.secret, "[secret]").Replace(text)
}

// fail maps an error answer: HTTP 401 is an authentication failure,
// business code 400 a bad request, 500 an internal error, 6xx see msg
// ("开发必读").
func (p *Provider) fail(status, code int, msg string) error {
	text := p.scrub(dnsx.Short(fmt.Sprintf("DNS.LA HTTP %d code %d %s", status, code, msg)))
	kind := dnsx.ErrProvider
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		kind = dnsx.ErrAuth
	case status == http.StatusTooManyRequests:
		kind = dnsx.ErrRateLimited
	case status >= 500 || code == 500:
		kind = dnsx.ErrUnreachable
	case code == 400:
		kind = dnsx.ErrInvalid
	case status == http.StatusNotFound:
		kind = dnsx.ErrZoneNotFound
	}
	return &apiError{kind: kind, code: code, text: kind.Error() + ": " + text}
}

func (p *Provider) call(ctx context.Context, method, path string, query url.Values, in, out any) error {
	var body []byte
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return fmt.Errorf("%w: encoding request", dnsx.ErrInvalid)
		}
	}
	target := p.baseURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(p.id+":"+p.secret)))
	if in != nil {
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "edgeweir-certd/1")
	status, raw, err := dnsx.Do(p.client, req)
	if err != nil {
		return err
	}
	var env struct {
		Code int             `json:"code"`
		Msg  string          `json:"msg"`
		Data json.RawMessage `json:"data"`
	}
	decoded := json.Unmarshal(raw, &env) == nil
	switch {
	case status < 200 || status > 299:
		if !decoded {
			env.Msg = string(raw)
		}
		return p.fail(status, env.Code, env.Msg)
	case !decoded:
		return fmt.Errorf("%w: invalid DNS.LA response", dnsx.ErrProvider)
	case env.Code != 200:
		return p.fail(status, env.Code, env.Msg)
	}
	if out != nil && len(env.Data) > 0 && string(env.Data) != "null" && json.Unmarshal(env.Data, out) != nil {
		return fmt.Errorf("%w: invalid DNS.LA data", dnsx.ErrProvider)
	}
	return nil
}

type record struct {
	ID         string `json:"id"`
	Host       string `json:"host"`
	Type       int    `json:"type"`
	LineID     string `json:"lineId"`
	Data       string `json:"data"`
	TTL        int    `json:"ttl"`
	Preference int    `json:"preference"`
}

type recordBody struct {
	ID         string `json:"id,omitempty"`
	DomainID   string `json:"domainId,omitempty"`
	Type       int    `json:"type"`
	Host       string `json:"host"`
	Data       string `json:"data"`
	TTL        int    `json:"ttl"`
	Preference int    `json:"preference,omitempty"`
}

func toRR(r record, zone string) libdns.RR {
	data := r.Data
	if r.Type == types["MX"] {
		data = fmt.Sprintf("%d %s", r.Preference, r.Data)
	}
	return dnsx.RR(dnsx.Relative(r.Host, zone), typeName(r.Type), data, r.TTL)
}

// isDefault reports whether a record is on the default line (empty lineId).
func isDefault(r record) bool { return r.LineID == "" || r.LineID == "0" }

// body turns an input record into the API form (MX preference is its own
// field).
func body(r libdns.RR) (recordBody, error) {
	code, ok := types[strings.ToUpper(r.Type)]
	if !ok {
		return recordBody{}, fmt.Errorf("%w: DNS.LA does not support %s records", dnsx.ErrUnsupported, r.Type)
	}
	out := recordBody{Type: code, Host: r.Name, Data: r.Data, TTL: dnsx.Seconds(r.TTL)}
	if out.Host == "" {
		out.Host = "@"
	}
	if code == types["MX"] {
		prio, target, found := strings.Cut(strings.TrimSpace(r.Data), " ")
		n, err := strconv.Atoi(prio)
		if !found || err != nil {
			return out, fmt.Errorf("%w: MX data must be \"preference target\"", dnsx.ErrInvalid)
		}
		out.Data, out.Preference = strings.TrimSpace(target), n
	}
	return out, nil
}

// domainID looks the zone up by name ("获取域名"). The reference does not
// document the answer for an unknown name; a 6xx business code ("see msg")
// or empty data counts as an unknown zone.
func (p *Provider) domainID(ctx context.Context, zone string) (string, error) {
	name := dnsx.Zone(zone)
	var d struct {
		ID     string `json:"id"`
		Domain string `json:"domain"`
	}
	err := p.call(ctx, http.MethodGet, "/api/domain", url.Values{"domain": {name}}, nil, &d)
	var api *apiError
	if errors.As(err, &api) && api.code >= 600 {
		return "", fmt.Errorf("%w: %s", dnsx.ErrZoneNotFound, api.text)
	}
	if err != nil {
		return "", err
	}
	if d.ID == "" || (d.Domain != "" && dnsx.Zone(d.Domain) != name) {
		return "", fmt.Errorf("%w: %s is not a zone of this DNS.LA account", dnsx.ErrZoneNotFound, name)
	}
	return d.ID, nil
}

func (p *Provider) list(ctx context.Context, domainID string) ([]record, error) {
	var all []record
	for page := 1; ; page++ {
		var res struct {
			Total   int      `json:"total"`
			Results []record `json:"results"`
		}
		query := url.Values{"pageIndex": {strconv.Itoa(page)}, "pageSize": {strconv.Itoa(pageSize)}, "domainId": {domainID}}
		if err := p.call(ctx, http.MethodGet, "/api/recordList", query, nil, &res); err != nil {
			return nil, err
		}
		all = append(all, res.Results...)
		if len(all) > maxRecords {
			return nil, fmt.Errorf("%w: DNS.LA zone exceeds %d records", dnsx.ErrProvider, maxRecords)
		}
		if len(res.Results) == 0 || len(all) >= res.Total {
			return all, nil
		}
	}
}

func (p *Provider) create(ctx context.Context, domainID string, r libdns.RR) error {
	in, err := body(r)
	if err != nil {
		return err
	}
	in.DomainID = domainID
	return p.call(ctx, http.MethodPost, "/api/record", nil, in, nil)
}

func (p *Provider) remove(ctx context.Context, recordID string) error {
	return p.call(ctx, http.MethodDelete, "/api/record", url.Values{"id": {recordID}}, nil, nil)
}

// GetRecords lists every record of the zone (all lines, system NS records
// included).
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	domainID, err := p.domainID(ctx, zone)
	if err != nil {
		return nil, err
	}
	all, err := p.list(ctx, domainID)
	if err != nil {
		return nil, err
	}
	out := make([]libdns.Record, 0, len(all))
	for _, r := range all {
		out = append(out, toRR(r, zone))
	}
	return out, nil
}

// check rejects input the API cannot take before anything changes.
func check(records []libdns.RR) error {
	for _, r := range records {
		if _, err := body(r); err != nil {
			return err
		}
	}
	return nil
}

// AppendRecords creates the records on the default line.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := check(dnsx.RRs(records)); err != nil {
		return nil, err
	}
	domainID, err := p.domainID(ctx, zone)
	if err != nil {
		return nil, err
	}
	var done []libdns.Record
	for _, r := range dnsx.RRs(records) {
		if err := p.create(ctx, domainID, r); err != nil {
			return done, err
		}
		done = append(done, r)
	}
	return done, nil
}

func normalize(records []libdns.Record) []libdns.RR {
	out := dnsx.RRs(records)
	for i := range out {
		if out[i].Name == "" {
			out[i].Name = "@"
		}
	}
	return out
}

// SetRecords makes each input RRset exactly the input records on the
// default line: matching default-line members are kept (TTL rewritten when
// it differs), every other member of the RRset (any line) is removed, and
// missing ones are created.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := check(dnsx.RRs(records)); err != nil {
		return nil, err
	}
	domainID, err := p.domainID(ctx, zone)
	if err != nil {
		return nil, err
	}
	existing, err := p.list(ctx, domainID)
	if err != nil {
		return nil, err
	}
	input := normalize(records)
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
		key := dnsx.Key(rr)
		if want, ok := wanted[key]; ok && isDefault(old) && !kept[key] {
			kept[key] = true
			if dnsx.Seconds(want.TTL) != dnsx.Seconds(rr.TTL) {
				in, err := body(want)
				if err != nil {
					return nil, err
				}
				in.ID = old.ID
				if err := p.call(ctx, http.MethodPut, "/api/record", nil, in, nil); err != nil {
					return nil, err
				}
			}
			continue
		}
		if err := p.remove(ctx, old.ID); err != nil {
			return nil, err
		}
	}
	for _, r := range input {
		if kept[dnsx.Key(r)] {
			continue
		}
		kept[dnsx.Key(r)] = true
		if err := p.create(ctx, domainID, r); err != nil {
			return nil, err
		}
	}
	return records, nil
}

// DeleteRecords removes the matching records on every line (data empty:
// the whole RRset).
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	domainID, err := p.domainID(ctx, zone)
	if err != nil {
		return nil, err
	}
	existing, err := p.list(ctx, domainID)
	if err != nil {
		return nil, err
	}
	input := normalize(records)
	var deleted []libdns.Record
	for _, old := range existing {
		rr := toRR(old, zone)
		for _, in := range input {
			if dnsx.Matches(rr, in) {
				if err := p.remove(ctx, old.ID); err != nil {
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
	for page := 1; len(zones) <= maxRecords; page++ {
		var res struct {
			Total   int `json:"total"`
			Results []struct {
				Domain string `json:"domain"`
			} `json:"results"`
		}
		query := url.Values{"pageIndex": {strconv.Itoa(page)}, "pageSize": {strconv.Itoa(pageSize)}}
		if err := p.call(ctx, http.MethodGet, "/api/domainList", query, nil, &res); err != nil {
			return nil, err
		}
		for _, d := range res.Results {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(d.Domain) + "."})
		}
		if len(res.Results) == 0 || len(zones) >= res.Total {
			return zones, nil
		}
	}
	return nil, fmt.Errorf("%w: DNS.LA account exceeds %d domains", dnsx.ErrProvider, maxRecords)
}
