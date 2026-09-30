// Package baiducloud is the Baidu AI Cloud DNS (智能云解析) adapter for the
// public DNS API (https://cloud.baidu.com/doc/DNS/s/El4s7lssr): JSON over
// HTTPS at dns.baidubce.com, every request signed with bce-auth-v1
// (https://cloud.baidu.com/doc/Reference/s/njwvz1yfu).
package baiducloud

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	endpoint    = "https://dns.baidubce.com"
	expiration  = 1800 // seconds a signature stays valid
	defaultLine = "default"
	pageSize    = 1000 // documented maximum of maxKeys
	maxRecords  = 100000
)

var accessKeyPattern = regexp.MustCompile(`^[A-Za-z0-9]{16,128}$`)

// Provider talks to one Baidu AI Cloud account.
type Provider struct {
	accessKey string
	secretKey string
	baseURL   string
	client    *http.Client
	now       func() time.Time
	mu        sync.Mutex // serializes read-modify-write per provider
}

// New builds the adapter from the catalog fields (access_key_id,
// secret_access_key).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	ak, sk := fields["access_key_id"], fields["secret_access_key"]
	if !accessKeyPattern.MatchString(ak) {
		return nil, fmt.Errorf("%w: Baidu Cloud access_key_id must be 16-128 letters or digits", dnsx.ErrInvalid)
	}
	if sk == "" || len(sk) > 256 || strings.ContainsFunc(sk, func(r rune) bool { return unicode.IsSpace(r) || !unicode.IsPrint(r) }) {
		return nil, fmt.Errorf("%w: Baidu Cloud secret_access_key is malformed", dnsx.ErrInvalid)
	}
	return &Provider{accessKey: ak, secretKey: sk, baseURL: opts.Endpoint(endpoint), client: opts.Client(), now: time.Now}, nil
}

// uriEncode is UriEncode of the signing spec: RFC 3986 unreserved characters
// stay, every other byte is percent-encoded in upper case; slash only stays
// when keepSlash is set (UriEncodeExceptSlash).
func uriEncode(s string, keepSlash bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9', c == '-', c == '.', c == '_', c == '~':
			b.WriteByte(c)
		case c == '/' && keepSlash:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// canonicalQuery encodes the query the way the signature sees it; the same
// string is sent on the wire.
func canonicalQuery(query url.Values) string {
	var items []string
	for k, values := range query {
		if strings.EqualFold(k, "authorization") {
			continue
		}
		for _, v := range values {
			items = append(items, uriEncode(k, false)+"="+uriEncode(v, false))
		}
	}
	sort.Strings(items)
	return strings.Join(items, "&")
}

func hmacHex(key, message string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil))
}

// authorization builds the bce-auth-v1 string. headers are the headers to
// sign (names in any case); listHeaders writes their names into the string
// (without it the service assumes its default header set).
func authorization(ak, sk, method, path string, query url.Values, headers map[string]string, at time.Time, listHeaders bool) string {
	prefix := fmt.Sprintf("bce-auth-v1/%s/%s/%d", ak, at.UTC().Format("2006-01-02T15:04:05Z"), expiration)
	signingKey := hmacHex(sk, prefix)
	var lines, names []string
	for name, value := range headers {
		name, value = strings.ToLower(name), strings.TrimSpace(value)
		if value == "" {
			continue
		}
		lines = append(lines, uriEncode(name, false)+":"+uriEncode(value, false))
		names = append(names, name)
	}
	sort.Strings(lines)
	sort.Strings(names)
	if path == "" || path[0] != '/' {
		path = "/" + path
	}
	canonical := strings.Join([]string{method, uriEncode(path, true), canonicalQuery(query), strings.Join(lines, "\n")}, "\n")
	signed := ""
	if listHeaders {
		signed = strings.Join(names, ";")
	}
	return prefix + "/" + signed + "/" + hmacHex(signingKey, canonical)
}

type failure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// scrub removes the credentials from provider text.
func (p *Provider) scrub(text string) string {
	return strings.NewReplacer(p.accessKey, "[access key]", p.secretKey, "[secret]").Replace(text)
}

// fail maps an error answer ("公共头和错误返回",
// https://cloud.baidu.com/doc/DNS/s/lkk5elv58).
func (p *Provider) fail(status int, raw []byte) error {
	var f failure
	_ = json.Unmarshal(raw, &f)
	message := p.scrub(dnsx.Short(strings.TrimSpace(f.Code + " " + f.Message)))
	switch f.Code {
	case "AccessDenied", "InvalidAccessKeyId", "InvalidHTTPAuthHeader", "SignatureDoesNotMatch":
		return fmt.Errorf("%w: Baidu Cloud DNS %s", dnsx.ErrAuth, message)
	case "InappropriateJSON":
		return fmt.Errorf("%w: Baidu Cloud DNS %s", dnsx.ErrInvalid, message)
	}
	return &dnsx.StatusError{Status: status, Message: message}
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
		target += "?" + canonicalQuery(query)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	at := p.now().UTC()
	date := at.Format("2006-01-02T15:04:05Z")
	signed := map[string]string{"host": req.URL.Host, "x-bce-date": date}
	if in != nil {
		signed["content-type"] = "application/json; charset=utf-8"
		req.Header.Set("Content-Type", signed["content-type"])
	}
	req.Header.Set("x-bce-date", date)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "edgeweir-certd/1")
	req.Header.Set("Authorization", authorization(p.accessKey, p.secretKey, method, path, query, signed, at, true))
	status, raw, err := dnsx.Do(p.client, req)
	if err != nil {
		return err
	}
	if status < 200 || status > 299 {
		return p.fail(status, raw)
	}
	if out == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if json.Unmarshal(raw, out) != nil {
		return fmt.Errorf("%w: invalid Baidu Cloud DNS response", dnsx.ErrProvider)
	}
	return nil
}

// id accepts a JSON string or number.
type id string

func (i *id) UnmarshalJSON(b []byte) error {
	var s string
	if json.Unmarshal(b, &s) == nil {
		*i = id(s)
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	*i = id(n.String())
	return nil
}

type record struct {
	ID       id     `json:"id"`
	RR       string `json:"rr"`
	Type     string `json:"type"`
	Value    string `json:"value"`
	TTL      int    `json:"ttl"`
	Line     string `json:"line"`
	Priority int    `json:"priority"`
}

type recordBody struct {
	RR       string `json:"rr"`
	Type     string `json:"type"`
	Value    string `json:"value"`
	TTL      int    `json:"ttl"`
	Line     string `json:"line,omitempty"`
	Priority *int   `json:"priority,omitempty"`
}

func zonePath(zone string) string { return "/v1/dns/zone/" + dnsx.Zone(zone) }

func toRR(r record, zone string) libdns.RR {
	data := r.Value
	if strings.EqualFold(r.Type, "MX") {
		data = fmt.Sprintf("%d %s", r.Priority, r.Value)
	}
	return dnsx.RR(dnsx.Relative(r.RR, zone), r.Type, data, r.TTL)
}

// supported are the record types the API accepts.
var supported = map[string]bool{"A": true, "AAAA": true, "CNAME": true, "MX": true, "TXT": true, "NS": true, "SRV": true}

func isDefault(r record) bool { return r.Line == "" || r.Line == defaultLine }

// body turns an input record into the API form (MX priority is its own field).
func body(r libdns.RR, line string) (recordBody, error) {
	name := r.Name
	if name == "" {
		name = "@"
	}
	out := recordBody{RR: name, Type: strings.ToUpper(r.Type), Value: r.Data, TTL: dnsx.Seconds(r.TTL), Line: line}
	if !supported[out.Type] {
		return out, fmt.Errorf("%w: Baidu Cloud DNS does not support %s records", dnsx.ErrUnsupported, r.Type)
	}
	if out.Type == "MX" {
		prio, target, ok := strings.Cut(strings.TrimSpace(r.Data), " ")
		n, err := strconv.Atoi(prio)
		if !ok || err != nil {
			return out, fmt.Errorf("%w: MX data must be \"priority target\"", dnsx.ErrInvalid)
		}
		out.Value, out.Priority = strings.TrimSpace(target), &n
	}
	return out, nil
}

func (p *Provider) list(ctx context.Context, zone string) ([]record, error) {
	var all []record
	marker := ""
	for {
		query := url.Values{"maxKeys": {strconv.Itoa(pageSize)}}
		if marker != "" {
			query.Set("marker", marker)
		}
		var page struct {
			IsTruncated bool     `json:"isTruncated"`
			NextMarker  string   `json:"nextMarker"`
			Records     []record `json:"records"`
		}
		if err := p.call(ctx, http.MethodGet, zonePath(zone)+"/record", query, nil, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Records...)
		if len(all) > maxRecords {
			return nil, fmt.Errorf("%w: Baidu Cloud DNS zone exceeds %d records", dnsx.ErrProvider, maxRecords)
		}
		if !page.IsTruncated || page.NextMarker == "" {
			return all, nil
		}
		if page.NextMarker == marker {
			return nil, fmt.Errorf("%w: Baidu Cloud DNS repeated a page marker", dnsx.ErrProvider)
		}
		marker = page.NextMarker
	}
}

func (p *Provider) create(ctx context.Context, zone string, r libdns.RR) error {
	in, err := body(r, defaultLine)
	if err != nil {
		return err
	}
	return p.call(ctx, http.MethodPost, zonePath(zone)+"/record", nil, in, nil)
}

func (p *Provider) update(ctx context.Context, zone string, recordID id, r libdns.RR) error {
	in, err := body(r, "")
	if err != nil {
		return err
	}
	return p.call(ctx, http.MethodPut, zonePath(zone)+"/record/"+string(recordID), nil, in, nil)
}

func (p *Provider) remove(ctx context.Context, zone string, recordID id) error {
	return p.call(ctx, http.MethodDelete, zonePath(zone)+"/record/"+string(recordID), nil, nil, nil)
}

// GetRecords lists every record of the zone (all lines).
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

// check rejects input the API cannot take before anything changes.
func check(records []libdns.RR) error {
	for _, r := range records {
		if _, err := body(r, ""); err != nil {
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
	var done []libdns.Record
	for _, r := range dnsx.RRs(records) {
		if err := p.create(ctx, zone, r); err != nil {
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
	existing, err := p.list(ctx, zone)
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
				if err := p.update(ctx, zone, old.ID, want); err != nil {
					return nil, err
				}
			}
			continue
		}
		if err := p.remove(ctx, zone, old.ID); err != nil {
			return nil, err
		}
	}
	for _, r := range input {
		if kept[dnsx.Key(r)] {
			continue
		}
		kept[dnsx.Key(r)] = true
		if err := p.create(ctx, zone, r); err != nil {
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
	existing, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	input := normalize(records)
	var deleted []libdns.Record
	for _, old := range existing {
		rr := toRR(old, zone)
		for _, in := range input {
			if dnsx.Matches(rr, in) {
				if err := p.remove(ctx, zone, old.ID); err != nil {
					return deleted, err
				}
				deleted = append(deleted, rr)
				break
			}
		}
	}
	return deleted, nil
}

// ListZones lists the account's public zones.
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var zones []libdns.Zone
	marker := ""
	for len(zones) <= maxRecords {
		query := url.Values{"maxKeys": {strconv.Itoa(pageSize)}}
		if marker != "" {
			query.Set("marker", marker)
		}
		var page struct {
			IsTruncated bool   `json:"isTruncated"`
			NextMarker  string `json:"nextMarker"`
			Zones       []struct {
				Name string `json:"name"`
			} `json:"zones"`
		}
		if err := p.call(ctx, http.MethodGet, "/v1/dns/zone", query, nil, &page); err != nil {
			return nil, err
		}
		for _, z := range page.Zones {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(z.Name) + "."})
		}
		if !page.IsTruncated || page.NextMarker == "" || page.NextMarker == marker {
			return zones, nil
		}
		marker = page.NextMarker
	}
	return nil, fmt.Errorf("%w: Baidu Cloud DNS account exceeds %d zones", dnsx.ErrProvider, maxRecords)
}
