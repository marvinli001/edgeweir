// Package googleclouddns is the Google Cloud DNS adapter: the Cloud DNS API
// v1 (https://cloud.google.com/dns/docs/reference/rest/v1) with a service
// account key exchanged for an OAuth 2.0 access token through a signed JWT
// (https://developers.google.com/identity/protocols/oauth2/service-account),
// written with the standard library because the libdns module pulls the
// Google API client.
//
// Cloud DNS keeps one object per name and type (a record set). Writes go
// through changes.create, which applies additions and deletions atomically
// and requires every deletion to match the current record set exactly, so a
// concurrent change makes the call fail instead of being overwritten. Record
// sets with a routing policy are skipped by GetRecords, refused by
// AppendRecords, left alone by DeleteRecords and replaced by SetRecords.
package googleclouddns

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	apiEndpoint   = "https://dns.googleapis.com"
	tokenEndpoint = "https://oauth2.googleapis.com/token"
	scope         = "https://www.googleapis.com/auth/ndev.clouddns.readwrite"
	maxRecords    = 100000
	maxPages      = 2000
)

var (
	// Project IDs, including legacy domain-scoped ones ("example.com:proj").
	projectPattern = regexp.MustCompile(`^([a-z][a-z0-9.-]{0,62}:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$`)
	// Managed zone names or numeric IDs.
	zonePattern  = regexp.MustCompile(`^([a-z][a-z0-9-]{0,62}|[0-9]{1,20})$`)
	emailPattern = regexp.MustCompile(`^[^@\s]{1,128}@[A-Za-z0-9.-]{1,253}$`)
	keyIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
)

// serviceAccount is the JSON key file of a Google service account.
type serviceAccount struct {
	Type         string `json:"type"`
	ProjectID    string `json:"project_id"`
	PrivateKeyID string `json:"private_key_id"`
	PrivateKey   string `json:"private_key"`
	ClientEmail  string `json:"client_email"`
	Universe     string `json:"universe_domain"`
}

// Provider talks to Cloud DNS as one service account.
type Provider struct {
	email, keyID string
	key          *rsa.PrivateKey
	project      string
	managedZone  string // managed_zone, optional
	apiURL       string
	tokenURL     string
	client       *http.Client
	now          func() time.Time
	mu           sync.Mutex // serializes read-modify-write of record sets
	tmu          sync.Mutex
	token        string
	expiry       time.Time
	zmu          sync.Mutex
	zones        map[string]string // zone -> managed zone name
}

// New builds the adapter from the catalog fields (service_account_json,
// project_id, managed_zone). The token endpoint and API are fixed; the key
// file's token_uri is not followed.
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	var sa serviceAccount
	if json.Unmarshal([]byte(fields["service_account_json"]), &sa) != nil || sa.Type != "service_account" {
		return nil, fmt.Errorf("%w: Google Cloud DNS service_account_json must be a service account key file", dnsx.ErrInvalid)
	}
	if !emailPattern.MatchString(sa.ClientEmail) {
		return nil, fmt.Errorf("%w: Google Cloud DNS service account key has no client_email", dnsx.ErrInvalid)
	}
	if sa.Universe != "" && sa.Universe != "googleapis.com" {
		return nil, fmt.Errorf("%w: Google Cloud DNS supports the googleapis.com universe only", dnsx.ErrInvalid)
	}
	key, err := parseKey(sa.PrivateKey)
	if err != nil {
		return nil, err
	}
	project := strings.TrimSpace(fields["project_id"])
	if project == "" {
		project = sa.ProjectID
	}
	if !projectPattern.MatchString(project) {
		return nil, fmt.Errorf("%w: Google Cloud DNS project_id is malformed", dnsx.ErrInvalid)
	}
	zone := strings.TrimSpace(fields["managed_zone"])
	if zone != "" && !zonePattern.MatchString(zone) {
		return nil, fmt.Errorf("%w: Google Cloud DNS managed_zone must be a zone name or ID", dnsx.ErrInvalid)
	}
	keyID := sa.PrivateKeyID
	if !keyIDPattern.MatchString(keyID) {
		keyID = ""
	}
	tokenURL := tokenEndpoint
	if opts.BaseURL != "" {
		tokenURL = opts.Endpoint(tokenEndpoint) + "/token"
	}
	return &Provider{
		email: sa.ClientEmail, keyID: keyID, key: key, project: project, managedZone: zone,
		apiURL: opts.Endpoint(apiEndpoint), tokenURL: tokenURL, client: opts.Client(),
		now: time.Now, zones: map[string]string{},
	}, nil
}

func parseKey(text string) (*rsa.PrivateKey, error) {
	invalid := fmt.Errorf("%w: Google Cloud DNS private_key must be an RSA key in PEM form", dnsx.ErrInvalid)
	block, _ := pem.Decode([]byte(text))
	if block == nil {
		return nil, invalid
	}
	var parsed any
	var err error
	switch block.Type {
	case "PRIVATE KEY":
		parsed, err = x509.ParsePKCS8PrivateKey(block.Bytes)
	case "RSA PRIVATE KEY":
		parsed, err = x509.ParsePKCS1PrivateKey(block.Bytes)
	default:
		return nil, invalid
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if err != nil || !ok || key.N.BitLen() < 2048 {
		return nil, invalid
	}
	return key, nil
}

func b64(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }

type jwtHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
	Kid string `json:"kid,omitempty"`
}

type jwtClaims struct {
	Iss   string `json:"iss"`
	Scope string `json:"scope"`
	Aud   string `json:"aud"`
	Iat   int64  `json:"iat"`
	Exp   int64  `json:"exp"`
}

// assertion is the RS256 JWT for the token request. iat is backdated 30 s
// against clock skew; exp is iat + 1 h, the maximum Google accepts.
func (p *Provider) assertion(now time.Time) (string, error) {
	iat := now.Add(-30 * time.Second).Unix()
	header, _ := json.Marshal(jwtHeader{Alg: "RS256", Typ: "JWT", Kid: p.keyID})
	claims, _ := json.Marshal(jwtClaims{Iss: p.email, Scope: scope, Aud: tokenEndpoint, Iat: iat, Exp: iat + 3600})
	unsigned := b64(header) + "." + b64(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(nil, p.key, crypto.SHA256, digest[:])
	if err != nil {
		return "", fmt.Errorf("%w: signing the token request", dnsx.ErrInvalid)
	}
	return unsigned + "." + b64(signature), nil
}

// accessToken returns a cached access token or gets a new one.
func (p *Provider) accessToken(ctx context.Context) (string, error) {
	p.tmu.Lock()
	defer p.tmu.Unlock()
	now := p.now()
	if p.token != "" && now.Before(p.expiry) {
		return p.token, nil
	}
	assertion, err := p.assertion(now)
	if err != nil {
		return "", err
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {assertion}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "edgeweir-certd/1")
	status, body, err := dnsx.Do(p.client, req)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		var e struct {
			Error       string `json:"error"`
			Description string `json:"error_description"`
		}
		_ = json.Unmarshal(body, &e)
		text := dnsx.Short(strings.TrimSpace(e.Error + " " + e.Description))
		switch {
		case status == http.StatusTooManyRequests:
			return "", fmt.Errorf("%w: Google OAuth %s", dnsx.ErrRateLimited, text)
		case status >= 500:
			return "", &dnsx.StatusError{Status: status, Message: "Google OAuth " + text}
		default: // invalid_grant, invalid_client, unauthorized_client, ...
			return "", fmt.Errorf("%w: Google OAuth %s", dnsx.ErrAuth, text)
		}
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if json.Unmarshal(body, &out) != nil || out.AccessToken == "" {
		return "", fmt.Errorf("%w: invalid Google OAuth response", dnsx.ErrProvider)
	}
	p.token = out.AccessToken
	p.expiry = now.Add(time.Duration(max(out.ExpiresIn-60, 0)) * time.Second)
	return p.token, nil
}

type googleError struct {
	Error struct {
		Message string `json:"message"`
		Status  string `json:"status"`
		Errors  []struct {
			Reason string `json:"reason"`
		} `json:"errors"`
	} `json:"error"`
}

// apiError maps Google API errors (HTTP status plus errors[].reason, see
// https://cloud.google.com/dns/docs/error-messages). Quota errors arrive as
// 403 and are rate limits, not authentication failures.
func apiError(status int, body []byte) error {
	var e googleError
	_ = json.Unmarshal(body, &e)
	reason := e.Error.Status
	if len(e.Error.Errors) > 0 && e.Error.Errors[0].Reason != "" {
		reason = e.Error.Errors[0].Reason
	}
	text := dnsx.Short(strings.TrimSpace(reason + " " + e.Error.Message))
	switch reason {
	case "rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "RESOURCE_EXHAUSTED":
		return fmt.Errorf("%w: Cloud DNS %s", dnsx.ErrRateLimited, text)
	}
	return &dnsx.StatusError{Status: status, Message: "Cloud DNS " + text}
}

// call sends a request to /dns/v1/projects/{project}{path}.
func (p *Provider) call(ctx context.Context, method, path string, query url.Values, in, out any) error {
	token, err := p.accessToken(ctx)
	if err != nil {
		return err
	}
	target := p.apiURL + "/dns/v1/projects/" + url.PathEscape(p.project) + path
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
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "edgeweir-certd/1")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	status, raw, err := dnsx.Do(p.client, req)
	if err != nil {
		return err
	}
	if status < 200 || status > 299 {
		return apiError(status, raw)
	}
	if out != nil && json.Unmarshal(raw, out) != nil {
		return fmt.Errorf("%w: invalid Cloud DNS response", dnsx.ErrProvider)
	}
	return nil
}

type managedZone struct {
	Name       string `json:"name"`
	DNSName    string `json:"dnsName"`
	Visibility string `json:"visibility"`
}

// managedZoneFor resolves the public managed zone serving zone: the
// configured managed_zone (checked against its DNS name) or managedZones.list
// filtered by dnsName.
func (p *Provider) managedZoneFor(ctx context.Context, zone string) (string, error) {
	zone = dnsx.Zone(zone) + "."
	p.zmu.Lock()
	defer p.zmu.Unlock()
	if name, ok := p.zones[zone]; ok {
		return name, nil
	}
	name := p.managedZone
	if name != "" {
		var z managedZone
		if err := p.call(ctx, http.MethodGet, "/managedZones/"+url.PathEscape(name), nil, nil, &z); err != nil {
			return "", err
		}
		if strings.ToLower(z.DNSName) != zone || z.Visibility == "private" {
			return "", fmt.Errorf("%w: managed zone %s is not the public zone %s", dnsx.ErrZoneNotFound, name, zone)
		}
	} else {
		var found []string
		query := url.Values{"dnsName": {zone}}
		for page := 0; page < maxPages; page++ {
			var out struct {
				Zones []managedZone `json:"managedZones"`
				Next  string        `json:"nextPageToken"`
			}
			if err := p.call(ctx, http.MethodGet, "/managedZones", query, nil, &out); err != nil {
				return "", err
			}
			for _, z := range out.Zones {
				if strings.ToLower(z.DNSName) == zone && z.Visibility != "private" && zonePattern.MatchString(z.Name) {
					found = append(found, z.Name)
				}
			}
			if out.Next == "" {
				break
			}
			query.Set("pageToken", out.Next)
		}
		switch len(found) {
		case 0:
			return "", fmt.Errorf("%w: no public Cloud DNS managed zone %s", dnsx.ErrZoneNotFound, zone)
		case 1:
			name = found[0]
		default:
			return "", fmt.Errorf("%w: several public Cloud DNS managed zones serve %s; set managed_zone", dnsx.ErrInvalid, zone)
		}
	}
	p.zones[zone] = name
	return name, nil
}

type rrset struct {
	Name    string          `json:"name"`
	Type    string          `json:"type"`
	TTL     int             `json:"ttl"`
	Rrdatas []string        `json:"rrdatas"`
	Routing json.RawMessage `json:"routingPolicy"`
	raw     json.RawMessage // echoed in deletions
}

func (s rrset) simple() bool {
	return len(s.Routing) == 0 || string(s.Routing) == "null"
}

// newSet is a record set for additions.
type newSet struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	TTL     int      `json:"ttl"`
	Rrdatas []string `json:"rrdatas"`
}

// list returns the zone's record sets, or with name set only the record set
// of that name and type.
func (p *Provider) list(ctx context.Context, managed, name, typ string) ([]rrset, error) {
	query := url.Values{}
	if name != "" {
		query.Set("name", name)
		query.Set("type", typ)
	}
	var sets []rrset
	count := 0
	for page := 0; page < maxPages; page++ {
		var out struct {
			Sets []json.RawMessage `json:"rrsets"`
			Next string            `json:"nextPageToken"`
		}
		if err := p.call(ctx, http.MethodGet, "/managedZones/"+url.PathEscape(managed)+"/rrsets", query, nil, &out); err != nil {
			return nil, err
		}
		for _, raw := range out.Sets {
			var s rrset
			if json.Unmarshal(raw, &s) != nil {
				return nil, fmt.Errorf("%w: invalid Cloud DNS record set", dnsx.ErrProvider)
			}
			s.raw = raw
			if name != "" && (!strings.EqualFold(s.Name, name) || !strings.EqualFold(s.Type, typ)) {
				continue
			}
			sets = append(sets, s)
			if count += max(len(s.Rrdatas), 1); count > maxRecords {
				return nil, fmt.Errorf("%w: Cloud DNS zone exceeds %d records", dnsx.ErrProvider, maxRecords)
			}
		}
		if out.Next == "" {
			return sets, nil
		}
		query.Set("pageToken", out.Next)
	}
	return nil, fmt.Errorf("%w: Cloud DNS listing does not end", dnsx.ErrProvider)
}

func toRRs(s rrset, zone string) []libdns.RR {
	name := dnsx.Relative(s.Name, zone)
	typ := strings.ToUpper(s.Type)
	out := make([]libdns.RR, 0, len(s.Rrdatas))
	for _, v := range s.Rrdatas {
		if typ == "TXT" || typ == "SPF" {
			v = unquoteTXT(v)
		}
		out = append(out, dnsx.RR(name, typ, v, s.TTL))
	}
	return out
}

// GetRecords lists the records of every record set without a routing policy.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	managed, err := p.managedZoneFor(ctx, zone)
	if err != nil {
		return nil, err
	}
	sets, err := p.list(ctx, managed, "", "")
	if err != nil {
		return nil, err
	}
	var out []libdns.Record
	for _, s := range sets {
		if s.simple() {
			for _, rr := range toRRs(s, zone) {
				out = append(out, rr)
			}
		}
	}
	return out, nil
}

// group is the input for one record set.
type group struct {
	fqdn, typ string
	records   []libdns.RR // names normalized to the relative form
}

func groups(zone string, records []libdns.Record) []*group {
	var out []*group
	index := map[string]*group{}
	for _, r := range dnsx.RRs(records) {
		fqdn := strings.ToLower(dnsx.FQDN(r.Name, zone)) + "."
		r.Name = dnsx.Relative(fqdn, zone)
		r.Type = strings.ToUpper(r.Type)
		key := fqdn + "\x00" + r.Type
		g := index[key]
		if g == nil {
			g = &group{fqdn: fqdn, typ: r.Type}
			index[key] = g
			out = append(out, g)
		}
		g.records = append(g.records, r)
	}
	return out
}

// unique drops duplicate data and returns the rrdatas and the smallest TTL
// (a record set has one TTL).
func (g *group) unique() (rrdatas []string, ttl int, kept []libdns.RR) {
	seen := map[string]bool{}
	for _, r := range g.records {
		if s := dnsx.Seconds(r.TTL); ttl == 0 || s < ttl {
			ttl = s
		}
		key := dnsx.CanonicalData(g.typ, r.Data)
		if seen[key] {
			continue
		}
		seen[key] = true
		rrdatas = append(rrdatas, encodeData(g.typ, r.Data))
		kept = append(kept, r)
	}
	return rrdatas, ttl, kept
}

func encodeData(typ, data string) string {
	switch typ {
	case "TXT", "SPF":
		return quoteTXT(data)
	case "CNAME", "ALIAS":
		if !strings.HasSuffix(data, ".") {
			return data + "."
		}
	}
	return data
}

type change struct {
	Additions []newSet          `json:"additions,omitempty"`
	Deletions []json.RawMessage `json:"deletions,omitempty"`
}

func (p *Provider) submit(ctx context.Context, managed string, c change) error {
	if len(c.Additions) == 0 && len(c.Deletions) == 0 {
		return nil
	}
	return p.call(ctx, http.MethodPost, "/managedZones/"+url.PathEscape(managed)+"/changes", nil, c, nil)
}

func allSimple(sets []rrset) bool {
	for _, s := range sets {
		if !s.simple() {
			return false
		}
	}
	return true
}

func sameSet(s rrset, typ string, ttl int, records []libdns.RR, zone string) bool {
	if s.TTL != ttl {
		return false
	}
	have := map[string]bool{}
	for _, rr := range toRRs(s, zone) {
		have[dnsx.CanonicalData(typ, rr.Data)] = true
	}
	if len(have) != len(records) {
		return false
	}
	for _, r := range records {
		if !have[dnsx.CanonicalData(typ, r.Data)] {
			return false
		}
	}
	return true
}

// AppendRecords adds the records to their record sets (deletion of the
// listed set and addition of the union, keeping the set's TTL) and returns
// the records that were added.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	managed, err := p.managedZoneFor(ctx, zone)
	if err != nil {
		return nil, err
	}
	var c change
	var added []libdns.Record
	for _, g := range groups(zone, records) {
		existing, err := p.list(ctx, managed, g.fqdn, g.typ)
		if err != nil {
			return nil, err
		}
		if !allSimple(existing) {
			return nil, fmt.Errorf("%w: %s %s has a routing policy", dnsx.ErrUnsupported, g.fqdn, g.typ)
		}
		if len(existing) == 0 {
			rrdatas, ttl, kept := g.unique()
			c.Additions = append(c.Additions, newSet{g.fqdn, g.typ, ttl, rrdatas})
			for _, r := range kept {
				added = append(added, dnsx.RR(r.Name, r.Type, r.Data, ttl))
			}
			continue
		}
		current := existing[0]
		have := map[string]bool{}
		for _, rr := range toRRs(current, zone) {
			have[dnsx.CanonicalData(g.typ, rr.Data)] = true
		}
		rrdatas := append([]string{}, current.Rrdatas...)
		var fresh []libdns.Record
		for _, r := range g.records {
			if key := dnsx.CanonicalData(g.typ, r.Data); !have[key] {
				have[key] = true
				rrdatas = append(rrdatas, encodeData(g.typ, r.Data))
				fresh = append(fresh, dnsx.RR(r.Name, r.Type, r.Data, current.TTL))
			}
		}
		if len(fresh) == 0 {
			continue
		}
		c.Deletions = append(c.Deletions, current.raw)
		c.Additions = append(c.Additions, newSet{g.fqdn, g.typ, current.TTL, rrdatas})
		added = append(added, fresh...)
	}
	if err := p.submit(ctx, managed, c); err != nil {
		return nil, err
	}
	return added, nil
}

// SetRecords makes each input record set exactly the input records
// (deletion of the listed sets of that name and type, addition of the new
// one). Unchanged sets are not sent.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	managed, err := p.managedZoneFor(ctx, zone)
	if err != nil {
		return nil, err
	}
	var c change
	var out []libdns.Record
	for _, g := range groups(zone, records) {
		existing, err := p.list(ctx, managed, g.fqdn, g.typ)
		if err != nil {
			return nil, err
		}
		rrdatas, ttl, kept := g.unique()
		for _, r := range kept {
			out = append(out, dnsx.RR(r.Name, r.Type, r.Data, ttl))
		}
		if len(existing) == 1 && existing[0].simple() && sameSet(existing[0], g.typ, ttl, kept, zone) {
			continue
		}
		for _, s := range existing {
			c.Deletions = append(c.Deletions, s.raw)
		}
		c.Additions = append(c.Additions, newSet{g.fqdn, g.typ, ttl, rrdatas})
	}
	if err := p.submit(ctx, managed, c); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteRecords removes matching records from record sets without a routing
// policy (data empty: the whole set) and returns them.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	managed, err := p.managedZoneFor(ctx, zone)
	if err != nil {
		return nil, err
	}
	var c change
	var deleted []libdns.Record
	for _, g := range groups(zone, records) {
		existing, err := p.list(ctx, managed, g.fqdn, g.typ)
		if err != nil {
			return nil, err
		}
		for _, s := range existing {
			if !s.simple() {
				continue
			}
			var keep []string
			var gone []libdns.Record
			for i, rr := range toRRs(s, zone) {
				matched := false
				for _, in := range g.records {
					if dnsx.Matches(rr, in) {
						matched = true
						break
					}
				}
				if matched {
					gone = append(gone, rr)
				} else {
					keep = append(keep, s.Rrdatas[i])
				}
			}
			if len(gone) == 0 {
				continue
			}
			c.Deletions = append(c.Deletions, s.raw)
			if len(keep) > 0 {
				c.Additions = append(c.Additions, newSet{g.fqdn, g.typ, s.TTL, keep})
			}
			deleted = append(deleted, gone...)
		}
	}
	if err := p.submit(ctx, managed, c); err != nil {
		return nil, err
	}
	return deleted, nil
}

// ListZones lists the project's public managed zones.
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	query := url.Values{}
	var zones []libdns.Zone
	for page := 0; page < maxPages; page++ {
		var out struct {
			Zones []managedZone `json:"managedZones"`
			Next  string        `json:"nextPageToken"`
		}
		if err := p.call(ctx, http.MethodGet, "/managedZones", query, nil, &out); err != nil {
			return nil, err
		}
		for _, z := range out.Zones {
			if z.Visibility != "private" {
				zones = append(zones, libdns.Zone{Name: dnsx.Zone(z.DNSName) + "."})
			}
		}
		if out.Next == "" {
			break
		}
		query.Set("pageToken", out.Next)
	}
	return zones, nil
}

// quoteTXT turns text into zone-file TXT data: strings of at most 255 bytes
// in double quotes, \" and \\ escaped, other bytes outside printable ASCII
// as \DDD (decimal, RFC 1035).
func quoteTXT(text string) string {
	var parts []string
	for first := true; first || text != ""; first = false {
		n := min(255, len(text))
		var b strings.Builder
		b.WriteByte('"')
		for i := 0; i < n; i++ {
			switch c := text[i]; {
			case c == '"' || c == '\\':
				b.WriteByte('\\')
				b.WriteByte(c)
			case c < 0x20 || c >= 0x7f:
				fmt.Fprintf(&b, "\\%03d", c)
			default:
				b.WriteByte(c)
			}
		}
		b.WriteByte('"')
		parts = append(parts, b.String())
		text = text[n:]
	}
	return strings.Join(parts, " ")
}

// unquoteTXT concatenates the strings of zone-file TXT data; unquoted data
// is returned as is.
func unquoteTXT(value string) string {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, `"`) {
		return value
	}
	var out []byte
	quoted := false
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c == '\\' && i+1 < len(value):
			if i+3 < len(value) && isDigit(value[i+1]) && isDigit(value[i+2]) && isDigit(value[i+3]) {
				if n, err := strconv.ParseUint(value[i+1:i+4], 10, 8); err == nil {
					out = append(out, byte(n))
					i += 3
					continue
				}
			}
			out = append(out, value[i+1])
			i++
		case c == '"':
			quoted = !quoted
		case quoted:
			out = append(out, c)
		}
	}
	return string(out)
}

func isDigit(c byte) bool { return '0' <= c && c <= '9' }
