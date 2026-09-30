// Package volcengine is the Volcengine DNS (火山引擎云解析 DNS, TrafficRoute)
// adapter for OpenAPI version 2018-08-01
// (https://www.volcengine.com/docs/6758/155086): GET (query) and POST (JSON)
// requests to dns.volcengineapi.com signed with HMAC-SHA256
// (https://www.volcengine.com/docs/6758/155088).
//
// It does not wrap github.com/libdns/volcengine v0.0.1: that module keeps
// request parameters from one action in the next, reads only the first
// page of records and zones, updates or creates single records instead of
// replacing RRsets, and returns untyped errors.
package volcengine

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
	endpoint = "https://dns.volcengineapi.com"
	version  = "2018-08-01"
	// Signing scope of the official SDKs and the API reference examples.
	region      = "cn-beijing"
	service     = "dns"
	defaultLine = "default"
	pageSize    = 500 // documented maximum of PageSize
	maxRecords  = 100000
)

// Provider talks to one Volcengine account.
type Provider struct {
	accessKey string
	secretKey string
	baseURL   string
	client    *http.Client
	now       func() time.Time
	mu        sync.Mutex // serializes read-modify-write per provider
}

func malformed(s string, max int, allowed func(rune) bool) bool {
	return s == "" || len(s) > max || strings.ContainsFunc(s, func(r rune) bool { return !allowed(r) })
}

// New builds the adapter from the catalog fields (access_key_id,
// secret_access_key).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	ak, sk := fields["access_key_id"], fields["secret_access_key"]
	alnum := func(r rune) bool { return r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)) }
	if malformed(ak, 128, alnum) || len(ak) < 16 {
		return nil, fmt.Errorf("%w: Volcengine access_key_id must be 16-128 letters or digits", dnsx.ErrInvalid)
	}
	if malformed(sk, 256, func(r rune) bool { return r < unicode.MaxASCII && unicode.IsGraphic(r) && !unicode.IsSpace(r) }) {
		return nil, fmt.Errorf("%w: Volcengine secret_access_key is malformed", dnsx.ErrInvalid)
	}
	return &Provider{accessKey: ak, secretKey: sk, baseURL: opts.Endpoint(endpoint), client: opts.Client(), now: time.Now}, nil
}

func sum(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func mac(key []byte, message string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(message))
	return m.Sum(nil)
}

// canonicalQuery sorts the query by name and percent-encodes it (RFC 3986,
// spaces as %20); the same string is sent on the wire.
func canonicalQuery(query url.Values) string {
	return strings.ReplaceAll(query.Encode(), "+", "%20")
}

// authorization builds the Authorization header value. headers are the
// headers to sign with their values; query is already canonical.
func authorization(ak, sk, region, service, method, path, query string, headers map[string]string, payloadHash string, at time.Time) string {
	names := make([]string, 0, len(headers))
	values := map[string]string{}
	for name, value := range headers {
		name = strings.ToLower(name)
		names = append(names, name)
		values[name] = strings.TrimSpace(value)
	}
	sort.Strings(names)
	var canonicalHeaders strings.Builder
	for _, name := range names {
		canonicalHeaders.WriteString(name + ":" + values[name] + "\n")
	}
	signedHeaders := strings.Join(names, ";")
	canonical := strings.Join([]string{method, path, query, canonicalHeaders.String(), signedHeaders, payloadHash}, "\n")
	date := at.UTC().Format("20060102T150405Z")
	scope := date[:8] + "/" + region + "/" + service + "/request"
	toSign := strings.Join([]string{"HMAC-SHA256", date, scope, sum([]byte(canonical))}, "\n")
	key := mac(mac(mac(mac([]byte(sk), date[:8]), region), service), "request")
	return "HMAC-SHA256 Credential=" + ak + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + hex.EncodeToString(mac(key, toSign))
}

type envelope struct {
	ResponseMetadata struct {
		Error *struct {
			Code    string `json:"Code"`
			Message string `json:"Message"`
		} `json:"Error"`
	} `json:"ResponseMetadata"`
	Result json.RawMessage `json:"Result"`
}

// scrub removes the credentials from provider text (InvalidAccessKey echoes
// the access key).
func (p *Provider) scrub(text string) string {
	return strings.NewReplacer(p.accessKey, "[access key]", p.secretKey, "[secret]").Replace(text)
}

// fail maps an error answer: gateway codes
// (https://www.volcengine.com/docs/6369/68677) and DNS codes
// (https://www.volcengine.com/docs/6758/155089).
func (p *Provider) fail(status int, code, message string) error {
	text := p.scrub(dnsx.Short(strings.TrimSpace(code + " " + message)))
	switch code {
	case "InvalidAccessKey", "SignatureDoesNotMatch", "AccessDenied", "InvalidAuthorization", "InvalidCredential", "InvalidSecretToken":
		return fmt.Errorf("%w: Volcengine DNS %s", dnsx.ErrAuth, text)
	case "ErrZoneNotFound":
		return fmt.Errorf("%w: Volcengine DNS %s", dnsx.ErrZoneNotFound, text)
	case "FlowLimitExceeded":
		return fmt.Errorf("%w: Volcengine DNS %s", dnsx.ErrRateLimited, text)
	case "ErrParamInvalid", "ErrHostCanNotBeEmpty", "ErrSpecNotValid":
		return fmt.Errorf("%w: Volcengine DNS %s", dnsx.ErrInvalid, text)
	}
	if status >= 200 && status <= 299 {
		return fmt.Errorf("%w: Volcengine DNS %s", dnsx.ErrProvider, text)
	}
	return &dnsx.StatusError{Status: status, Message: text}
}

// call runs one action: GET actions carry their parameters in the query,
// POST actions in a JSON body.
func (p *Provider) call(ctx context.Context, method, action string, params url.Values, in, out any) error {
	query := url.Values{}
	for k, v := range params {
		query[k] = v
	}
	query.Set("Action", action)
	query.Set("Version", version)
	body := []byte{}
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return fmt.Errorf("%w: encoding request", dnsx.ErrInvalid)
		}
	}
	rawQuery := canonicalQuery(query)
	req, err := http.NewRequestWithContext(ctx, method, p.baseURL+"/?"+rawQuery, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	at := p.now().UTC()
	signed := map[string]string{
		"content-type":     "application/json",
		"host":             req.URL.Host,
		"x-content-sha256": sum(body),
		"x-date":           at.Format("20060102T150405Z"),
	}
	req.Header.Set("Content-Type", signed["content-type"])
	req.Header.Set("X-Content-Sha256", signed["x-content-sha256"])
	req.Header.Set("X-Date", signed["x-date"])
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "edgeweir-certd/1")
	req.Header.Set("Authorization", authorization(p.accessKey, p.secretKey, region, service, method, "/", rawQuery, signed, signed["x-content-sha256"], at))
	status, raw, err := dnsx.Do(p.client, req)
	if err != nil {
		return err
	}
	var env envelope
	decoded := json.Unmarshal(raw, &env) == nil
	if decoded && env.ResponseMetadata.Error != nil && env.ResponseMetadata.Error.Code != "" {
		return p.fail(status, env.ResponseMetadata.Error.Code, env.ResponseMetadata.Error.Message)
	}
	if status < 200 || status > 299 {
		return p.fail(status, "", "")
	}
	if !decoded {
		return fmt.Errorf("%w: invalid Volcengine DNS response", dnsx.ErrProvider)
	}
	if out != nil && len(env.Result) > 0 && json.Unmarshal(env.Result, out) != nil {
		return fmt.Errorf("%w: invalid Volcengine DNS result", dnsx.ErrProvider)
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
	RecordID id     `json:"RecordID"`
	Host     string `json:"Host"`
	Type     string `json:"Type"`
	TTL      int    `json:"TTL"`
	Line     string `json:"Line"`
	Value    string `json:"Value"`
}

type zoneInfo struct {
	ZID      int64  `json:"ZID"`
	ZoneName string `json:"ZoneName"`
}

func toRR(r record, zone string) libdns.RR {
	return dnsx.RR(dnsx.Relative(r.Host, zone), r.Type, r.Value, r.TTL)
}

func isDefault(r record) bool { return r.Line == "" || r.Line == defaultLine }

func host(r libdns.RR) string {
	if r.Name == "" {
		return "@"
	}
	return r.Name
}

// zoneID finds the ZID of a zone (ListZones, exact name match).
func (p *Provider) zoneID(ctx context.Context, zone string) (int64, error) {
	name := dnsx.Zone(zone)
	var res struct {
		Zones []zoneInfo `json:"Zones"`
	}
	params := url.Values{"Key": {name}, "SearchMode": {"exact"}, "PageNumber": {"1"}, "PageSize": {strconv.Itoa(pageSize)}}
	if err := p.call(ctx, http.MethodGet, "ListZones", params, nil, &res); err != nil {
		return 0, err
	}
	for _, z := range res.Zones {
		if dnsx.Zone(z.ZoneName) == name && z.ZID != 0 {
			return z.ZID, nil
		}
	}
	return 0, fmt.Errorf("%w: %s is not a zone of this Volcengine account", dnsx.ErrZoneNotFound, name)
}

func (p *Provider) list(ctx context.Context, zid int64) ([]record, error) {
	var all []record
	for page := 1; ; page++ {
		var res struct {
			Records    []record `json:"Records"`
			TotalCount int      `json:"TotalCount"`
		}
		params := url.Values{"ZID": {strconv.FormatInt(zid, 10)}, "PageNumber": {strconv.Itoa(page)}, "PageSize": {strconv.Itoa(pageSize)}}
		if err := p.call(ctx, http.MethodGet, "ListRecords", params, nil, &res); err != nil {
			return nil, err
		}
		all = append(all, res.Records...)
		if len(all) > maxRecords {
			return nil, fmt.Errorf("%w: Volcengine DNS zone exceeds %d records", dnsx.ErrProvider, maxRecords)
		}
		if len(res.Records) == 0 || len(all) >= res.TotalCount {
			return all, nil
		}
	}
}

func (p *Provider) create(ctx context.Context, zid int64, r libdns.RR) error {
	return p.call(ctx, http.MethodPost, "CreateRecord", nil, map[string]any{
		"ZID": zid, "Host": host(r), "Type": strings.ToUpper(r.Type), "Value": r.Data, "TTL": dnsx.Seconds(r.TTL), "Line": defaultLine,
	}, nil)
}

func (p *Provider) remove(ctx context.Context, recordID id) error {
	return p.call(ctx, http.MethodPost, "DeleteRecord", nil, map[string]any{"RecordID": string(recordID)}, nil)
}

// GetRecords lists every record of the zone (all lines).
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	zid, err := p.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	all, err := p.list(ctx, zid)
	if err != nil {
		return nil, err
	}
	out := make([]libdns.Record, 0, len(all))
	for _, r := range all {
		out = append(out, toRR(r, zone))
	}
	return out, nil
}

// AppendRecords creates the records on the default line.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	zid, err := p.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	var done []libdns.Record
	for _, r := range dnsx.RRs(records) {
		if err := p.create(ctx, zid, r); err != nil {
			return done, err
		}
		done = append(done, r)
	}
	return done, nil
}

func normalize(records []libdns.Record) []libdns.RR {
	out := dnsx.RRs(records)
	for i := range out {
		out[i].Name = host(out[i])
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
	zid, err := p.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	existing, err := p.list(ctx, zid)
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
				if err := p.call(ctx, http.MethodPost, "UpdateRecord", nil, map[string]any{
					"RecordID": string(old.RecordID), "Host": old.Host, "Line": defaultLine, "Type": old.Type, "Value": old.Value, "TTL": dnsx.Seconds(want.TTL),
				}, nil); err != nil {
					return nil, err
				}
			}
			continue
		}
		if err := p.remove(ctx, old.RecordID); err != nil {
			return nil, err
		}
	}
	for _, r := range input {
		if kept[dnsx.Key(r)] {
			continue
		}
		kept[dnsx.Key(r)] = true
		if err := p.create(ctx, zid, r); err != nil {
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
	zid, err := p.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	existing, err := p.list(ctx, zid)
	if err != nil {
		return nil, err
	}
	input := normalize(records)
	var deleted []libdns.Record
	for _, old := range existing {
		rr := toRR(old, zone)
		for _, in := range input {
			if dnsx.Matches(rr, in) {
				if err := p.remove(ctx, old.RecordID); err != nil {
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
	for page := 1; len(zones) <= maxRecords; page++ {
		var res struct {
			Total int        `json:"Total"`
			Zones []zoneInfo `json:"Zones"`
		}
		params := url.Values{"PageNumber": {strconv.Itoa(page)}, "PageSize": {strconv.Itoa(pageSize)}}
		if err := p.call(ctx, http.MethodGet, "ListZones", params, nil, &res); err != nil {
			return nil, err
		}
		for _, z := range res.Zones {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(z.ZoneName) + "."})
		}
		if len(res.Zones) == 0 || len(zones) >= res.Total {
			return zones, nil
		}
	}
	return nil, fmt.Errorf("%w: Volcengine DNS account exceeds %d zones", dnsx.ErrProvider, maxRecords)
}
