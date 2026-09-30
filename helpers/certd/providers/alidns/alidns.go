// Package alidns is the Alibaba Cloud DNS adapter (Alidns API 2015-01-09,
// RPC style, ACS3-HMAC-SHA256 signatures,
// https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature).
// The published libdns module reads only the first page of records (20),
// has no RRset semantics and returns unclassified errors, so this adapter
// calls the documented API directly.
//
// Alibaba Cloud DNS has one public endpoint for the China and the
// international site (alidns.aliyuncs.com, API metadata "endpoints":
// cn-hangzhou and public). region_id is accepted for stored credentials,
// validated, and does not change the destination.
package alidns

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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
	endpoint   = "https://alidns.aliyuncs.com"
	apiVersion = "2015-01-09"
	pageSize   = 500 // DescribeDomainRecords maximum
	zonePage   = 100 // DescribeDomains maximum
	maxRecords = 100000
	// minTTL is the smallest TTL of the free and personal editions; writes
	// rejected for their TTL are retried with it.
	minTTL = 600
)

var (
	keyIDPattern  = regexp.MustCompile(`^[A-Za-z0-9.]{1,128}$`) // STS keys start with "STS."
	regionPattern = regexp.MustCompile(`^[a-z]{2,}(-[a-z0-9]+){1,4}$`)
)

// Provider talks to one Alibaba Cloud account.
type Provider struct {
	BaseURL string
	Client  *http.Client
	keyID   string
	secret  string
	token   string
	now     func() time.Time
	nonce   func() string
	mu      sync.Mutex // serialize read-modify-write sequences
}

// New builds the adapter from the catalog fields (access_key_id,
// access_key_secret, region_id, security_token).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	keyID, secret, token := fields["access_key_id"], fields["access_key_secret"], fields["security_token"]
	if !keyIDPattern.MatchString(keyID) {
		return nil, fmt.Errorf("%w: Alibaba Cloud access_key_id is malformed", dnsx.ErrInvalid)
	}
	if !printable(secret) || (token != "" && !printable(token)) {
		return nil, fmt.Errorf("%w: Alibaba Cloud access_key_secret or security_token is malformed", dnsx.ErrInvalid)
	}
	if region := fields["region_id"]; region != "" && (len(region) > 32 || !regionPattern.MatchString(region)) {
		return nil, fmt.Errorf("%w: Alibaba Cloud region_id is malformed", dnsx.ErrInvalid)
	}
	return &Provider{
		BaseURL: opts.Endpoint(endpoint), Client: opts.Client(),
		keyID: keyID, secret: secret, token: token,
		now: time.Now, nonce: randomNonce,
	}, nil
}

// printable reports whether a credential is non-empty visible ASCII.
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

func randomNonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// percentEncode is the RFC 3986 encoding ACS3 uses for query strings.
func percentEncode(s string) string {
	s = url.QueryEscape(s)
	s = strings.ReplaceAll(s, "+", "%20")
	s = strings.ReplaceAll(s, "*", "%2A")
	return strings.ReplaceAll(s, "%7E", "~")
}

func canonicalQuery(params map[string]string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, percentEncode(k)+"="+percentEncode(params[k]))
	}
	return strings.Join(parts, "&")
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// authorization computes the ACS3-HMAC-SHA256 Authorization header. headers
// are the lowercase host, x-acs-* and content-type headers to sign.
func authorization(keyID, secret, method, query string, headers map[string]string, payloadHash string) string {
	names := make([]string, 0, len(headers))
	for k := range headers {
		names = append(names, k)
	}
	sort.Strings(names)
	var canonical strings.Builder
	canonical.WriteString(method + "\n/\n" + query + "\n")
	for _, k := range names {
		canonical.WriteString(k + ":" + strings.TrimSpace(headers[k]) + "\n")
	}
	signed := strings.Join(names, ";")
	canonical.WriteString("\n" + signed + "\n" + payloadHash)
	toSign := "ACS3-HMAC-SHA256\n" + sha256Hex([]byte(canonical.String()))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(toSign))
	return "ACS3-HMAC-SHA256 Credential=" + keyID + ",SignedHeaders=" + signed + ",Signature=" + hex.EncodeToString(mac.Sum(nil))
}

type apiError struct {
	Code    string `json:"Code"`
	Message string `json:"Message"`
}

// call sends one RPC action with its parameters in the query string.
func (p *Provider) call(ctx context.Context, action string, params map[string]string, out any) error {
	target, err := url.Parse(p.BaseURL + "/")
	if err != nil {
		return fmt.Errorf("%w: invalid endpoint", dnsx.ErrInvalid)
	}
	query := canonicalQuery(params)
	target.RawQuery = query
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), nil)
	if err != nil {
		return fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	payloadHash := sha256Hex(nil)
	headers := map[string]string{
		"host":                  target.Host,
		"x-acs-action":          action,
		"x-acs-version":         apiVersion,
		"x-acs-date":            p.now().UTC().Format("2006-01-02T15:04:05Z"),
		"x-acs-signature-nonce": p.nonce(),
		"x-acs-content-sha256":  payloadHash,
	}
	if p.token != "" {
		headers["x-acs-security-token"] = p.token
	}
	for k, v := range headers {
		if k != "host" {
			req.Header.Set(k, v)
		}
	}
	req.Header.Set("Authorization", authorization(p.keyID, p.secret, http.MethodPost, query, headers, payloadHash))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "edgeweir-certd/1 (DNS records)")
	status, body, err := dnsx.Do(p.Client, req)
	if err != nil {
		return err
	}
	var failure apiError
	_ = json.Unmarshal(body, &failure)
	if status >= 200 && status <= 299 && failure.Code == "" {
		if out != nil && json.Unmarshal(body, out) != nil {
			return fmt.Errorf("%w: invalid Alibaba Cloud DNS response", dnsx.ErrProvider)
		}
		return nil
	}
	return p.apiError(action, status, failure)
}

// failure is a classified API error that keeps the provider code.
type failure struct {
	kind error
	code string
	text string
}

func (f *failure) Error() string { return f.text }
func (f *failure) Unwrap() error { return f.kind }

// apiError maps Alibaba Cloud error codes (Alidns error center and the
// common gateway codes) before HTTP statuses: InvalidAccessKeyId.NotFound
// answers 404.
func (p *Provider) apiError(action string, status int, e apiError) error {
	var kind error
	switch {
	case e.Code == "":
		kind = (&dnsx.StatusError{Status: status}).Kind()
	case strings.HasPrefix(e.Code, "InvalidAccessKeyId"), strings.HasPrefix(e.Code, "InvalidSecurityToken"),
		e.Code == "SignatureDoesNotMatch", e.Code == "IncompleteSignature", e.Code == "Forbidden",
		e.Code == "Forbidden.RAM", e.Code == "Forbidden.AccessKeyDisabled", e.Code == "NoPermission":
		kind = dnsx.ErrAuth
	case e.Code == "InvalidDomainName.NoExist", e.Code == "IncorrectDomainUser", e.Code == "DomainNotExist":
		kind = dnsx.ErrZoneNotFound
	case strings.HasPrefix(e.Code, "Throttling"):
		kind = dnsx.ErrRateLimited
	case strings.HasPrefix(e.Code, "InvalidRR."), strings.HasPrefix(e.Code, "SubDomainInvalid."),
		strings.HasPrefix(e.Code, "InvalidParameter"), strings.HasPrefix(e.Code, "MissingParameter"),
		e.Code == "DomainRecordConflict", e.Code == "QuotaExceeded.TTL":
		kind = dnsx.ErrInvalid
	case status >= 500:
		kind = dnsx.ErrUnreachable
	default:
		kind = dnsx.ErrProvider
	}
	text := fmt.Sprintf("%s: Alibaba Cloud DNS %s HTTP %d %s %s", kind, action, status, e.Code, dnsx.Short(p.redact(e.Message)))
	return &failure{kind: kind, code: e.Code, text: strings.TrimSpace(text)}
}

// redact removes credentials a provider message might echo.
func (p *Provider) redact(s string) string {
	for _, secret := range []string{p.secret, p.token, p.keyID} {
		if secret != "" {
			s = strings.ReplaceAll(s, secret, "***")
		}
	}
	return s
}

func code(err error) string {
	var f *failure
	if errors.As(err, &f) {
		return f.code
	}
	return ""
}

type record struct {
	RecordID string `json:"RecordId"`
	RR       string `json:"RR"`
	Type     string `json:"Type"`
	Value    string `json:"Value"`
	TTL      int    `json:"TTL"`
	Line     string `json:"Line"`
}

func (r record) rr() libdns.RR {
	name := strings.ToLower(r.RR)
	if name == "" {
		name = "@"
	}
	data := r.Value
	if strings.EqualFold(r.Type, "TXT") {
		data = dnsx.Unquote(data)
	}
	return dnsx.RR(name, r.Type, data, r.TTL)
}

// main reports whether the record is on the default line.
func (r record) main() bool { return r.Line == "" || r.Line == "default" }

func (p *Provider) list(ctx context.Context, zone string) ([]record, error) {
	var all []record
	for page := 1; ; page++ {
		var res struct {
			TotalCount    int `json:"TotalCount"`
			DomainRecords struct {
				Record []record `json:"Record"`
			} `json:"DomainRecords"`
		}
		if err := p.call(ctx, "DescribeDomainRecords", map[string]string{
			"DomainName": dnsx.Zone(zone), "PageNumber": strconv.Itoa(page), "PageSize": strconv.Itoa(pageSize),
		}, &res); err != nil {
			return nil, err
		}
		all = append(all, res.DomainRecords.Record...)
		if len(all) > maxRecords {
			return nil, fmt.Errorf("%w: Alibaba Cloud DNS zone exceeds %d records", dnsx.ErrProvider, maxRecords)
		}
		if len(res.DomainRecords.Record) < pageSize || len(all) >= res.TotalCount {
			return all, nil
		}
	}
}

// GetRecords lists every record of the zone (all lines).
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	all, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	out := make([]libdns.Record, 0, len(all))
	for _, r := range all {
		out = append(out, r.rr())
	}
	return out, nil
}

// value is the record data in the API's form (hostnames without the root dot).
func value(r libdns.RR) string {
	if strings.EqualFold(r.Type, "CNAME") {
		return strings.TrimSuffix(r.Data, ".")
	}
	return r.Data
}

// write runs AddDomainRecord or UpdateDomainRecord; a TTL below the zone
// edition's minimum is retried with 600 s. It returns the record as stored.
func (p *Provider) write(ctx context.Context, action string, params map[string]string, r libdns.RR) (libdns.RR, error) {
	params["RR"], params["Type"], params["Value"] = r.Name, strings.ToUpper(r.Type), value(r)
	params["TTL"] = strconv.Itoa(dnsx.Seconds(r.TTL))
	err := p.call(ctx, action, params, nil)
	if c := code(err); (c == "QuotaExceeded.TTL" || c == "SubDomainInvalid.TTL") && dnsx.Seconds(r.TTL) < minTTL {
		r.TTL = minTTL * time.Second
		params["TTL"] = strconv.Itoa(minTTL)
		err = p.call(ctx, action, params, nil)
	}
	if code(err) == "DomainRecordDuplicate" {
		err = nil // the record already holds these values
	}
	return r, err
}

func (p *Provider) create(ctx context.Context, zone string, r libdns.RR) (libdns.RR, error) {
	return p.write(ctx, "AddDomainRecord", map[string]string{"DomainName": dnsx.Zone(zone)}, r)
}

func (p *Provider) update(ctx context.Context, id string, r libdns.RR) (libdns.RR, error) {
	return p.write(ctx, "UpdateDomainRecord", map[string]string{"RecordId": id}, r)
}

func (p *Provider) remove(ctx context.Context, id string) error {
	err := p.call(ctx, "DeleteDomainRecord", map[string]string{"RecordId": id}, nil)
	if c := code(err); c == "DomainRecordNotBelongToUser" || c == "InvalidRR.NoExist" {
		return nil // already gone
	}
	return err
}

// AppendRecords creates the records; an identical existing record counts as
// created.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var done []libdns.Record
	for _, r := range dnsx.RRs(records) {
		stored, err := p.create(ctx, zone, r)
		if err != nil {
			return done, err
		}
		done = append(done, stored)
	}
	return done, nil
}

// SetRecords makes each input RRset exactly the input records on the
// default line: matching members are kept (TTL updated), surplus default-line
// members are rewritten to missing values, the rest are created or deleted.
// Members on other lines are deleted.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	existing, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	members := make([]member, 0, len(existing))
	for _, r := range existing {
		members = append(members, member{id: r.RecordID, rr: r.rr(), main: r.main()})
	}
	pl := plan(members, dnsx.RRs(records))
	stored := map[string]libdns.RR{}
	for _, k := range pl.kept {
		stored[dnsx.Key(k.want)] = k.have
	}
	for _, u := range pl.updates {
		r, err := p.update(ctx, u.id, u.rr)
		if err != nil {
			return nil, err
		}
		stored[dnsx.Key(u.rr)] = r
	}
	for _, c := range pl.creates {
		r, err := p.create(ctx, zone, c)
		if err != nil {
			return nil, err
		}
		stored[dnsx.Key(c)] = r
	}
	for _, d := range pl.deletes {
		if err := p.remove(ctx, d.id); err != nil {
			return nil, err
		}
	}
	return pl.result(stored), nil
}

// DeleteRecords removes the matching records (data empty: the whole RRset).
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	existing, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	input := dnsx.RRs(records)
	var deleted []libdns.Record
	for _, old := range existing {
		rr := old.rr()
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

// ListZones lists the account's domains (punycode, lowercase, trailing dot).
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var zones []libdns.Zone
	for page := 1; len(zones) < maxRecords; page++ {
		var res struct {
			TotalCount int `json:"TotalCount"`
			Domains    struct {
				Domain []struct {
					DomainName string `json:"DomainName"`
					PunyCode   string `json:"PunyCode"`
				} `json:"Domain"`
			} `json:"Domains"`
		}
		if err := p.call(ctx, "DescribeDomains", map[string]string{
			"PageNumber": strconv.Itoa(page), "PageSize": strconv.Itoa(zonePage),
		}, &res); err != nil {
			return nil, err
		}
		for _, d := range res.Domains.Domain {
			name := strings.TrimSpace(d.PunyCode)
			if name == "" {
				name = strings.TrimSpace(d.DomainName)
			}
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(name) + "."})
		}
		if len(res.Domains.Domain) < zonePage || len(zones) >= res.TotalCount {
			break
		}
	}
	return zones, nil
}
