// Package huaweicloud is the Huawei Cloud DNS adapter (public zones, record
// set API v2.1, AK/SK "SDK-HMAC-SHA256" signatures,
// https://support.huaweicloud.com/devg-apisign/api-sign-algorithm-002.html).
// The published libdns module creates one record set per record (a second
// TXT value for the same name fails), overwrites an RRset with a single
// value in SetRecords, deletes whole RRsets in DeleteRecords and reads only
// the first page, so this adapter calls the documented API directly.
//
// Public zones are global resources reached through any region's endpoint
// dns.<region>.myhuaweicloud.com; the documentation names cn-north-4 for the
// China site and ap-southeast-3 for the international site. region_id only
// selects that label and is validated so it cannot change the host.
package huaweicloud

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

	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	defaultRegion = "cn-north-4"
	pageSize      = 500 // ShowRecordSetByZone / ListPublicZones maximum
	maxRecords    = 100000
	defaultLine   = "default_view"
)

var (
	keyIDPattern  = regexp.MustCompile(`^[A-Za-z0-9]{1,128}$`)
	regionPattern = regexp.MustCompile(`^[a-z]{2,}(-[a-z0-9]+){1,4}$`)
)

// Provider talks to one Huawei Cloud account.
type Provider struct {
	BaseURL string
	Client  *http.Client
	keyID   string
	secret  string
	now     func() time.Time
	mu      sync.Mutex // serialize read-modify-write sequences and the zone cache
	zones   map[string]string
}

// New builds the adapter from the catalog fields (access_key_id,
// secret_access_key, region_id).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	keyID, secret := fields["access_key_id"], fields["secret_access_key"]
	if !keyIDPattern.MatchString(keyID) {
		return nil, fmt.Errorf("%w: Huawei Cloud access_key_id is malformed", dnsx.ErrInvalid)
	}
	if !printable(secret) {
		return nil, fmt.Errorf("%w: Huawei Cloud secret_access_key is malformed", dnsx.ErrInvalid)
	}
	region := fields["region_id"]
	if region == "" {
		region = defaultRegion
	}
	if !validRegion(region) {
		return nil, fmt.Errorf("%w: Huawei Cloud region_id is malformed", dnsx.ErrInvalid)
	}
	return &Provider{
		BaseURL: opts.Endpoint("https://dns." + region + ".myhuaweicloud.com"), Client: opts.Client(),
		keyID: keyID, secret: secret, now: time.Now, zones: map[string]string{},
	}, nil
}

// validRegion accepts one DNS label of region form ("cn-north-4",
// "ap-southeast-3"): no dots, slashes, "@" or ports can reach the host.
func validRegion(region string) bool {
	return len(region) <= 32 && regionPattern.MatchString(region)
}

func printable(s string) bool {
	if s == "" || len(s) > 4096 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] <= ' ' || s[i] > '~' {
			return false
		}
	}
	return true
}

// escape is the signing encoding: everything but A-Z a-z 0-9 - _ . ~.
func escape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func canonicalURI(path string) string {
	segments := strings.Split(path, "/")
	for i, s := range segments {
		segments[i] = escape(s)
	}
	uri := strings.Join(segments, "/")
	if !strings.HasSuffix(uri, "/") {
		uri += "/"
	}
	return uri
}

func canonicalQuery(query url.Values) string {
	keys := make([]string, 0, len(query))
	for k := range query {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		values := append([]string(nil), query[k]...)
		sort.Strings(values)
		for _, v := range values {
			parts = append(parts, escape(k)+"="+escape(v))
		}
	}
	return strings.Join(parts, "&")
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// canonicalRequest builds the signed request form. headers are lowercase.
func canonicalRequest(method, uri, query string, headers map[string]string, payloadHash string) (string, string) {
	names := make([]string, 0, len(headers))
	for k := range headers {
		names = append(names, k)
	}
	sort.Strings(names)
	var b strings.Builder
	b.WriteString(method + "\n" + uri + "\n" + query + "\n")
	for _, k := range names {
		b.WriteString(k + ":" + strings.TrimSpace(headers[k]) + "\n")
	}
	signed := strings.Join(names, ";")
	b.WriteString("\n" + signed + "\n" + payloadHash)
	return b.String(), signed
}

// authorization signs a canonical request made at date (X-Sdk-Date form).
func authorization(keyID, secret, canonical, signed, date string) string {
	toSign := "SDK-HMAC-SHA256\n" + date + "\n" + sha256Hex([]byte(canonical))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(toSign))
	return "SDK-HMAC-SHA256 Access=" + keyID + ", SignedHeaders=" + signed + ", Signature=" + hex.EncodeToString(mac.Sum(nil))
}

type apiError struct {
	Code         string `json:"code"`
	Message      string `json:"message"`
	ErrorCode    string `json:"error_code"`
	ErrorMessage string `json:"error_msg"`
}

func (p *Provider) do(ctx context.Context, method, path string, query url.Values, in, out any) error {
	var body []byte
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return fmt.Errorf("%w: encoding request", dnsx.ErrInvalid)
		}
	}
	target, err := url.Parse(p.BaseURL + path)
	if err != nil {
		return fmt.Errorf("%w: invalid endpoint", dnsx.ErrInvalid)
	}
	target.RawQuery = canonicalQuery(query)
	req, err := http.NewRequestWithContext(ctx, method, target.String(), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	date := p.now().UTC().Format("20060102T150405Z")
	headers := map[string]string{"host": target.Host, "x-sdk-date": date}
	if in != nil {
		headers["content-type"] = "application/json"
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("X-Sdk-Date", date)
	canonical, signed := canonicalRequest(method, canonicalURI(target.Path), target.RawQuery, headers, sha256Hex(body))
	req.Header.Set("Authorization", authorization(p.keyID, p.secret, canonical, signed, date))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "edgeweir-certd/1 (DNS records)")
	status, raw, err := dnsx.Do(p.Client, req)
	if err != nil {
		return err
	}
	if status >= 200 && status <= 299 {
		if out != nil && len(bytes.TrimSpace(raw)) > 0 && json.Unmarshal(raw, out) != nil {
			return fmt.Errorf("%w: invalid Huawei Cloud DNS response", dnsx.ErrProvider)
		}
		return nil
	}
	var e apiError
	_ = json.Unmarshal(raw, &e)
	if e.Code == "" {
		e.Code, e.Message = e.ErrorCode, e.ErrorMessage
	}
	return p.apiError(method, status, e)
}

// apiError maps the DNS error codes (https://support.huaweicloud.com/api-dns/ErrorCode.html)
// and API Gateway codes before HTTP statuses.
func (p *Provider) apiError(method string, status int, e apiError) error {
	var kind error
	switch e.Code {
	case "DNS.0005", "DNS.0013", "DNS.0040", "APIGW.0301", "APIGW.0302", "APIGW.0303", "APIGW.0305":
		kind = dnsx.ErrAuth // authentication, permission, real-name verification
	case "DNS.0302":
		kind = dnsx.ErrZoneNotFound
	case "DNS.0021", "APIGW.0308":
		kind = dnsx.ErrRateLimited
	case "DNS.0016", "DNS.0303", "DNS.0308", "DNS.0312", "DNS.0319", "DNS.0335":
		kind = dnsx.ErrInvalid
	case "DNS.0313":
		kind = dnsx.ErrProvider // record set gone
	default:
		kind = (&dnsx.StatusError{Status: status}).Kind()
	}
	message := dnsx.Short(strings.ReplaceAll(strings.ReplaceAll(e.Message, p.secret, "***"), p.keyID, "***"))
	return fmt.Errorf("%w: Huawei Cloud DNS %s HTTP %d %s %s", kind, method, status, e.Code, message)
}

type zoneList struct {
	Zones []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"zones"`
	Metadata struct {
		TotalCount int `json:"total_count"`
	} `json:"metadata"`
}

func (p *Provider) zoneID(ctx context.Context, zone string) (string, error) {
	name := dnsx.Zone(zone)
	if id := p.zones[name]; id != "" {
		return id, nil
	}
	var res zoneList
	if err := p.do(ctx, http.MethodGet, "/v2/zones", url.Values{"type": {"public"}, "name": {name}, "search_mode": {"equal"}}, nil, &res); err != nil {
		return "", err
	}
	for _, z := range res.Zones {
		if dnsx.Zone(z.Name) == name && z.ID != "" {
			p.zones[name] = z.ID
			return z.ID, nil
		}
	}
	return "", fmt.Errorf("%w: Huawei Cloud DNS has no public zone %s", dnsx.ErrZoneNotFound, name)
}

type recordset struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	TTL     int      `json:"ttl"`
	Records []string `json:"records"`
	Line    string   `json:"line"`
	Default bool     `json:"default"` // system NS/SOA sets
}

func (rs recordset) rrs(zone string) []libdns.RR {
	name := dnsx.Relative(rs.Name, zone)
	out := make([]libdns.RR, 0, len(rs.Records))
	for _, v := range rs.Records {
		if strings.EqualFold(rs.Type, "TXT") {
			v = dnsx.Unquote(v)
		}
		out = append(out, dnsx.RR(name, rs.Type, v, rs.TTL))
	}
	return out
}

func (rs recordset) setKey(zone string) string {
	return dnsx.SetKey(libdns.RR{Name: dnsx.Relative(rs.Name, zone), Type: rs.Type})
}

func (rs recordset) main() bool { return rs.Line == "" || rs.Line == defaultLine }

func (p *Provider) list(ctx context.Context, zone string) (string, []recordset, error) {
	id, err := p.zoneID(ctx, zone)
	if err != nil {
		return "", nil, err
	}
	var all []recordset
	count := 0
	for offset := 0; ; offset += pageSize {
		var res struct {
			RecordSets []recordset `json:"recordsets"`
			Metadata   struct {
				TotalCount int `json:"total_count"`
			} `json:"metadata"`
		}
		if err := p.do(ctx, http.MethodGet, "/v2.1/zones/"+url.PathEscape(id)+"/recordsets",
			url.Values{"limit": {strconv.Itoa(pageSize)}, "offset": {strconv.Itoa(offset)}}, nil, &res); err != nil {
			return "", nil, err
		}
		all = append(all, res.RecordSets...)
		for _, rs := range res.RecordSets {
			count += len(rs.Records)
		}
		if count > maxRecords {
			return "", nil, fmt.Errorf("%w: Huawei Cloud DNS zone exceeds %d records", dnsx.ErrProvider, maxRecords)
		}
		if len(res.RecordSets) < pageSize || len(all) >= res.Metadata.TotalCount {
			return id, all, nil
		}
	}
}

// GetRecords lists every record of the zone (all lines), one per value.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	_, sets, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	var out []libdns.Record
	for _, rs := range sets {
		for _, r := range rs.rrs(zone) {
			out = append(out, r)
		}
	}
	return out, nil
}

// value is a record in the API's form: TXT quoted in strings of at most 255
// bytes, CNAME absolute.
func value(r libdns.RR) string {
	switch strings.ToUpper(r.Type) {
	case "TXT":
		var parts []string
		for data := r.Data; ; data = data[255:] {
			chunk := data
			if len(chunk) > 255 {
				chunk = chunk[:255]
			}
			chunk = strings.ReplaceAll(strings.ReplaceAll(chunk, `\`, `\\`), `"`, `\"`)
			parts = append(parts, `"`+chunk+`"`)
			if len(data) <= 255 {
				return strings.Join(parts, " ")
			}
		}
	case "CNAME":
		return strings.TrimSuffix(r.Data, ".") + "."
	}
	return r.Data
}

type body struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	TTL     int      `json:"ttl"`
	Records []string `json:"records"`
}

// rrset is one input RRset.
type rrset struct {
	key     string
	name    string
	typ     string
	ttl     int
	members []libdns.RR
}

// group splits the input into RRsets (input order, duplicates dropped).
func group(input []libdns.RR) []*rrset {
	var sets []*rrset
	index := map[string]*rrset{}
	seen := map[string]bool{}
	for _, r := range input {
		k := dnsx.SetKey(r)
		s := index[k]
		if s == nil {
			s = &rrset{key: k, name: strings.ToLower(r.Name), typ: strings.ToUpper(r.Type), ttl: dnsx.Seconds(r.TTL)}
			index[k] = s
			sets = append(sets, s)
		}
		if !seen[dnsx.Key(r)] {
			seen[dnsx.Key(r)] = true
			s.members = append(s.members, r)
		}
	}
	return sets
}

// find returns the default-line record set of an RRset and every other
// record set with the same name and type.
func find(sets []recordset, zone, key string) (*recordset, []recordset) {
	var primary *recordset
	var others []recordset
	for i := range sets {
		if sets[i].Default || sets[i].setKey(zone) != key {
			continue
		}
		if primary == nil && sets[i].main() {
			primary = &sets[i]
		} else {
			others = append(others, sets[i])
		}
	}
	return primary, others
}

func contains(values []libdns.RR, r libdns.RR) bool {
	for _, v := range values {
		if dnsx.Key(v) == dnsx.Key(r) {
			return true
		}
	}
	return false
}

func (p *Provider) create(ctx context.Context, zoneID, zone string, s *rrset, members []libdns.RR, ttl int) error {
	b := body{Name: dnsx.FQDN(s.name, zone) + ".", Type: s.typ, TTL: ttl}
	for _, m := range members {
		b.Records = append(b.Records, value(m))
	}
	return p.do(ctx, http.MethodPost, "/v2.1/zones/"+url.PathEscape(zoneID)+"/recordsets", nil, b, nil)
}

func (p *Provider) update(ctx context.Context, zoneID string, rs *recordset, records []string, ttl int) error {
	return p.do(ctx, http.MethodPut, "/v2.1/zones/"+url.PathEscape(zoneID)+"/recordsets/"+url.PathEscape(rs.ID), nil,
		body{Name: rs.Name, Type: rs.Type, TTL: ttl, Records: records}, nil)
}

func (p *Provider) remove(ctx context.Context, zoneID string, rs recordset) error {
	return p.do(ctx, http.MethodDelete, "/v2.1/zones/"+url.PathEscape(zoneID)+"/recordsets/"+url.PathEscape(rs.ID), nil, nil, nil)
}

// AppendRecords adds the records to their RRsets (a new default-line record
// set, or the existing one rewritten with the extra values; its TTL is kept).
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	zoneID, sets, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	var done []libdns.Record
	for _, s := range group(dnsx.RRs(records)) {
		primary, _ := find(sets, zone, s.key)
		if primary == nil {
			if err := p.create(ctx, zoneID, zone, s, s.members, s.ttl); err != nil {
				return done, err
			}
			done = append(done, dnsx.Records(s.members)...)
			continue
		}
		have := primary.rrs(zone)
		values := append([]string(nil), primary.Records...)
		var added []libdns.RR
		for _, m := range s.members {
			if !contains(have, m) {
				values = append(values, value(m))
				added = append(added, dnsx.RR(s.name, s.typ, m.Data, primary.TTL))
			}
		}
		if len(added) > 0 {
			if err := p.update(ctx, zoneID, primary, values, primary.TTL); err != nil {
				return done, err
			}
		}
		for _, m := range s.members {
			done = append(done, dnsx.RR(s.name, s.typ, m.Data, primary.TTL))
		}
	}
	return done, nil
}

// SetRecords writes each input RRset as one default-line record set (PUT of
// the whole set, or POST when missing) and deletes record sets with the same
// name and type on other lines.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	zoneID, sets, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	for _, s := range group(dnsx.RRs(records)) {
		primary, others := find(sets, zone, s.key)
		if primary == nil {
			err = p.create(ctx, zoneID, zone, s, s.members, s.ttl)
		} else if !same(primary.rrs(zone), s.members) || primary.TTL != s.ttl {
			values := make([]string, 0, len(s.members))
			for _, m := range s.members {
				values = append(values, value(m))
			}
			err = p.update(ctx, zoneID, primary, values, s.ttl)
		}
		if err != nil {
			return nil, err
		}
		for _, o := range others {
			if err := p.remove(ctx, zoneID, o); err != nil {
				return nil, err
			}
		}
	}
	return records, nil
}

// same reports whether two record lists hold the same values.
func same(a, b []libdns.RR) bool {
	if len(a) != len(b) {
		return false
	}
	for _, r := range b {
		if !contains(a, r) {
			return false
		}
	}
	return true
}

// DeleteRecords removes the matching values (data empty: the whole RRset);
// a record set left empty is deleted, otherwise rewritten.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	zoneID, sets, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	input := dnsx.RRs(records)
	var deleted []libdns.Record
	for i := range sets {
		rs := &sets[i]
		if rs.Default {
			continue
		}
		var keep []string
		var removed []libdns.Record
		for j, rr := range rs.rrs(zone) {
			matched := false
			for _, in := range input {
				if dnsx.Matches(rr, in) {
					matched = true
					break
				}
			}
			if matched {
				removed = append(removed, rr)
			} else {
				keep = append(keep, rs.Records[j])
			}
		}
		if len(removed) == 0 {
			continue
		}
		if len(keep) == 0 {
			err = p.remove(ctx, zoneID, *rs)
		} else {
			err = p.update(ctx, zoneID, rs, keep, rs.TTL)
		}
		if err != nil {
			return deleted, err
		}
		deleted = append(deleted, removed...)
	}
	return deleted, nil
}

// ListZones lists the account's public zones.
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var zones []libdns.Zone
	for offset := 0; offset < maxRecords; offset += pageSize {
		var res zoneList
		if err := p.do(ctx, http.MethodGet, "/v2/zones", url.Values{
			"type": {"public"}, "limit": {strconv.Itoa(pageSize)}, "offset": {strconv.Itoa(offset)},
		}, nil, &res); err != nil {
			return nil, err
		}
		for _, z := range res.Zones {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(z.Name) + "."})
		}
		if len(res.Zones) < pageSize || len(zones) >= res.Metadata.TotalCount {
			break
		}
	}
	return zones, nil
}
