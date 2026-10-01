// Package route53 is the Amazon Route 53 adapter: the REST/XML API
// (https://docs.aws.amazon.com/Route53/latest/APIReference/) signed with AWS
// Signature Version 4, written with the standard library because the libdns
// module pulls the AWS SDK.
//
// Route 53 keeps one object per name and type (a record set). Simple record
// sets are listed and edited member by member. Alias and routing-policy
// (SetIdentifier) record sets are skipped by GetRecords, refused by
// AppendRecords, left alone by DeleteRecords and replaced as a whole by
// SetRecords for their name and type. Each call sends at most one change
// batch, which Route 53 applies atomically; DELETE carries the record set
// exactly as listed, so a concurrent change makes the batch fail instead of
// being overwritten.
package route53

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	apiVersion = "2013-04-01"
	xmlNS      = "https://route53.amazonaws.com/doc/2013-04-01/"
	service    = "route53"
	maxRecords = 100000
	maxPages   = 2000
)

// Partitions and their signing regions
// (https://docs.aws.amazon.com/general/latest/gr/r53.html).
var partitions = map[string]struct{ endpoint, region string }{
	"aws":        {"https://route53.amazonaws.com", "us-east-1"},
	"aws-cn":     {"https://route53.amazonaws.com.cn", "cn-northwest-1"},
	"aws-us-gov": {"https://route53.us-gov.amazonaws.com", "us-gov-west-1"},
}

var (
	accessKeyPattern = regexp.MustCompile(`^\w{16,128}$`)
	zoneIDPattern    = regexp.MustCompile(`^[A-Z0-9]{1,32}$`)
)

// Provider talks to Route 53 with one set of access keys.
type Provider struct {
	creds   credentials
	region  string
	zoneID  string // hosted_zone_id, optional
	baseURL string
	client  *http.Client
	now     func() time.Time
	mu      sync.Mutex // serializes read-modify-write of record sets
	zmu     sync.Mutex
	zones   map[string]string // zone -> hosted zone ID
}

// New builds the adapter from the catalog fields (access_key_id,
// secret_access_key, session_token, hosted_zone_id, partition).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	key := strings.TrimSpace(fields["access_key_id"])
	secret, token := fields["secret_access_key"], fields["session_token"]
	if !accessKeyPattern.MatchString(key) {
		return nil, fmt.Errorf("%w: Route 53 access_key_id is malformed", dnsx.ErrInvalid)
	}
	if !printable(secret, 16, 128) {
		return nil, fmt.Errorf("%w: Route 53 secret_access_key is malformed", dnsx.ErrInvalid)
	}
	if token != "" && !printable(token, 16, 8192) {
		return nil, fmt.Errorf("%w: Route 53 session_token is malformed", dnsx.ErrInvalid)
	}
	zoneID := strings.TrimPrefix(strings.TrimSpace(fields["hosted_zone_id"]), "/hostedzone/")
	if zoneID != "" && !zoneIDPattern.MatchString(zoneID) {
		return nil, fmt.Errorf("%w: Route 53 hosted_zone_id must look like Z0123456789ABC", dnsx.ErrInvalid)
	}
	name := fields["partition"]
	if name == "" {
		name = "aws"
	}
	part, ok := partitions[name]
	if !ok {
		return nil, fmt.Errorf("%w: Route 53 partition must be aws, aws-cn or aws-us-gov", dnsx.ErrInvalid)
	}
	return &Provider{
		creds:   credentials{accessKey: key, secretKey: secret, token: token},
		region:  part.region,
		zoneID:  zoneID,
		baseURL: opts.Endpoint(part.endpoint),
		client:  opts.Client(),
		now:     time.Now,
		zones:   map[string]string{},
	}, nil
}

func printable(s string, min, max int) bool {
	if len(s) < min || len(s) > max {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] <= ' ' || s[i] >= 0x7f {
			return false
		}
	}
	return true
}

type aliasTarget struct {
	DNSName string `xml:"DNSName"`
}

type recordSet struct {
	Name          string       `xml:"Name"`
	Type          string       `xml:"Type"`
	SetIdentifier string       `xml:"SetIdentifier"`
	TrafficPolicy string       `xml:"TrafficPolicyInstanceId"`
	TTL           int          `xml:"TTL"`
	Values        []string     `xml:"ResourceRecords>ResourceRecord>Value"`
	Alias         *aliasTarget `xml:"AliasTarget"`
	Raw           string       `xml:",innerxml"` // echoed in DELETE changes
}

// simple reports a record set with plain values and the simple routing policy.
func (s recordSet) simple() bool {
	return s.Alias == nil && s.SetIdentifier == "" && s.TrafficPolicy == ""
}

type listResponse struct {
	Sets      []recordSet `xml:"ResourceRecordSets>ResourceRecordSet"`
	Truncated bool        `xml:"IsTruncated"`
	NextName  string      `xml:"NextRecordName"`
	NextType  string      `xml:"NextRecordType"`
	NextID    string      `xml:"NextRecordIdentifier"`
}

type hostedZone struct {
	ID      string `xml:"Id"`
	Name    string `xml:"Name"`
	Private bool   `xml:"Config>PrivateZone"`
}

type zonesResponse struct {
	Zones      []hostedZone `xml:"HostedZones>HostedZone"`
	Truncated  bool         `xml:"IsTruncated"`
	NextMarker string       `xml:"NextMarker"`       // ListHostedZones
	NextName   string       `xml:"NextDNSName"`      // ListHostedZonesByName
	NextZoneID string       `xml:"NextHostedZoneId"` // ListHostedZonesByName
}

type zoneResponse struct {
	Zone hostedZone `xml:"HostedZone"`
}

// errorResponse covers both error shapes: <ErrorResponse><Error> and
// <InvalidChangeBatch><Messages>.
type errorResponse struct {
	XMLName  xml.Name
	Code     string   `xml:"Error>Code"`
	Message  string   `xml:"Error>Message"`
	Messages []string `xml:"Messages>Message"`
}

// newRequest builds a signed request and returns its canonical form.
func (p *Provider) newRequest(ctx context.Context, method, path string, query [][2]string, body []byte) (*http.Request, string, error) {
	target := p.baseURL + "/" + apiVersion + path
	if len(query) > 0 {
		target += "?" + encodeQuery(query)
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, "", fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	req.Header.Set("User-Agent", "edgeweir-certd/1")
	if body != nil {
		req.Header.Set("Content-Type", "application/xml")
	}
	canonical := signV4(req, body, p.creds, p.region, service, p.now())
	return req, canonical, nil
}

func (p *Provider) request(ctx context.Context, method, path string, query [][2]string, body []byte, out any) error {
	req, _, err := p.newRequest(ctx, method, path, query, body)
	if err != nil {
		return err
	}
	status, raw, err := dnsx.Do(p.client, req)
	if err != nil {
		return err
	}
	if status < 200 || status > 299 {
		return p.apiError(status, raw)
	}
	if out != nil && xml.Unmarshal(raw, out) != nil {
		return fmt.Errorf("%w: invalid Route 53 response", dnsx.ErrProvider)
	}
	return nil
}

// apiError maps Route 53 errors (common errors and per-action errors of the
// API reference). Signature errors echo the canonical request, which carries
// the session token, so their message is dropped.
func (p *Provider) apiError(status int, body []byte) error {
	var e errorResponse
	_ = xml.Unmarshal(body, &e)
	code, message := e.Code, e.Message
	if e.XMLName.Local == "InvalidChangeBatch" {
		code, message = "InvalidChangeBatch", strings.Join(e.Messages, "; ")
	}
	if code == "SignatureDoesNotMatch" || code == "IncompleteSignature" {
		message = ""
	}
	text := dnsx.Short(strings.TrimSpace(code + " " + p.redact(message)))
	switch {
	case code == "Throttling" || code == "ThrottlingException" || code == "PriorRequestNotComplete":
		return fmt.Errorf("%w: Route 53 %s", dnsx.ErrRateLimited, text)
	case code == "NoSuchHostedZone":
		return fmt.Errorf("%w: Route 53 %s", dnsx.ErrZoneNotFound, text)
	case status == http.StatusNotFound:
		return fmt.Errorf("%w: Route 53 %s", dnsx.ErrProvider, text)
	}
	return &dnsx.StatusError{Status: status, Message: text}
}

func (p *Provider) redact(text string) string {
	for _, secret := range []string{p.creds.secretKey, p.creds.token} {
		if secret != "" {
			text = strings.ReplaceAll(text, secret, "[redacted]")
		}
	}
	return text
}

// hostedZone resolves the public hosted zone of zone: the configured
// hosted_zone_id (checked against the zone name) or ListHostedZonesByName.
func (p *Provider) hostedZone(ctx context.Context, zone string) (string, error) {
	zone = dnsx.Zone(zone) + "."
	p.zmu.Lock()
	defer p.zmu.Unlock()
	if id, ok := p.zones[zone]; ok {
		return id, nil
	}
	id := p.zoneID
	if id != "" {
		var out zoneResponse
		if err := p.request(ctx, http.MethodGet, "/hostedzone/"+id, nil, nil, &out); err != nil {
			return "", err
		}
		if unescapeName(out.Zone.Name) != zone || out.Zone.Private {
			return "", fmt.Errorf("%w: hosted zone %s is not the public zone %s", dnsx.ErrZoneNotFound, id, zone)
		}
	} else {
		var err error
		if id, err = p.findZone(ctx, zone); err != nil {
			return "", err
		}
	}
	p.zones[zone] = id
	return id, nil
}

func (p *Provider) findZone(ctx context.Context, zone string) (string, error) {
	query := [][2]string{{"dnsname", escapeName(zone)}, {"maxitems", "100"}}
	var found []string
	for page := 0; page < maxPages; page++ {
		var out zonesResponse
		if err := p.request(ctx, http.MethodGet, "/hostedzonesbyname", query, nil, &out); err != nil {
			return "", err
		}
		more := out.Truncated
		for _, z := range out.Zones {
			if unescapeName(z.Name) != zone {
				more = false
				break
			}
			if id := strings.TrimPrefix(z.ID, "/hostedzone/"); !z.Private && zoneIDPattern.MatchString(id) {
				found = append(found, id)
			}
		}
		if !more {
			break
		}
		query = [][2]string{{"dnsname", out.NextName}, {"hostedzoneid", out.NextZoneID}, {"maxitems", "100"}}
	}
	switch len(found) {
	case 0:
		return "", fmt.Errorf("%w: no public Route 53 hosted zone %s", dnsx.ErrZoneNotFound, zone)
	case 1:
		return found[0], nil
	default:
		return "", fmt.Errorf("%w: several public Route 53 hosted zones are named %s; set hosted_zone_id", dnsx.ErrInvalid, zone)
	}
}

// list returns the zone's record sets, or with name set only the record sets
// of that name and type (listing starts there, sorted by name and type).
func (p *Provider) list(ctx context.Context, id, name, typ string) ([]recordSet, error) {
	var sets []recordSet
	var start [][2]string
	if name != "" {
		start = [][2]string{{"name", escapeName(name)}, {"type", typ}}
	}
	count := 0
	for page := 0; page < maxPages; page++ {
		query := append(append([][2]string{}, start...), [2]string{"maxitems", "300"})
		var out listResponse
		if err := p.request(ctx, http.MethodGet, "/hostedzone/"+id+"/rrset", query, nil, &out); err != nil {
			return nil, err
		}
		for _, s := range out.Sets {
			if name != "" && (unescapeName(s.Name) != name || !strings.EqualFold(s.Type, typ)) {
				return sets, nil
			}
			sets = append(sets, s)
			if count += max(len(s.Values), 1); count > maxRecords {
				return nil, fmt.Errorf("%w: Route 53 zone exceeds %d records", dnsx.ErrProvider, maxRecords)
			}
		}
		if !out.Truncated {
			return sets, nil
		}
		start = [][2]string{{"name", out.NextName}, {"type", out.NextType}}
		if out.NextID != "" {
			start = append(start, [2]string{"identifier", out.NextID})
		}
	}
	return nil, fmt.Errorf("%w: Route 53 listing does not end", dnsx.ErrProvider)
}

func toRRs(s recordSet, zone string) []libdns.RR {
	name := dnsx.Relative(unescapeName(s.Name), zone)
	typ := strings.ToUpper(s.Type)
	out := make([]libdns.RR, 0, len(s.Values))
	for _, v := range s.Values {
		if typ == "TXT" || typ == "SPF" {
			v = unquoteTXT(v)
		}
		out = append(out, dnsx.RR(name, typ, v, s.TTL))
	}
	return out
}

// GetRecords lists the records of every simple record set in the zone.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	id, err := p.hostedZone(ctx, zone)
	if err != nil {
		return nil, err
	}
	sets, err := p.list(ctx, id, "", "")
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

// unique drops duplicate data and returns the Route 53 values and the
// smallest TTL (a record set has one TTL).
func (g *group) unique() (values []string, ttl int, kept []libdns.RR) {
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
		values = append(values, encodeValue(g.typ, r.Data))
		kept = append(kept, r)
	}
	return values, ttl, kept
}

func encodeValue(typ, data string) string {
	if typ == "TXT" || typ == "SPF" {
		return quoteTXT(data)
	}
	return data
}

type change struct {
	action string
	set    string // ResourceRecordSet inner XML
}

func setXML(fqdn, typ string, ttl int, values []string) string {
	var b strings.Builder
	b.WriteString("<Name>")
	_ = xml.EscapeText(&b, []byte(escapeName(fqdn)))
	b.WriteString("</Name><Type>" + typ + "</Type><TTL>" + strconv.Itoa(ttl) + "</TTL><ResourceRecords>")
	for _, v := range values {
		b.WriteString("<ResourceRecord><Value>")
		_ = xml.EscapeText(&b, []byte(v))
		b.WriteString("</Value></ResourceRecord>")
	}
	b.WriteString("</ResourceRecords>")
	return b.String()
}

func (p *Provider) submit(ctx context.Context, id string, changes []change) error {
	if len(changes) == 0 {
		return nil
	}
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	b.WriteString(`<ChangeResourceRecordSetsRequest xmlns="` + xmlNS + `"><ChangeBatch><Changes>`)
	for _, c := range changes {
		b.WriteString("<Change><Action>" + c.action + "</Action><ResourceRecordSet>" + c.set + "</ResourceRecordSet></Change>")
	}
	b.WriteString("</Changes></ChangeBatch></ChangeResourceRecordSetsRequest>")
	return p.request(ctx, http.MethodPost, "/hostedzone/"+id+"/rrset", nil, []byte(b.String()), nil)
}

func allSimple(sets []recordSet) bool {
	for _, s := range sets {
		if !s.simple() {
			return false
		}
	}
	return true
}

func sameSet(s recordSet, typ string, ttl int, records []libdns.RR, zone string) bool {
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

// AppendRecords adds the records to their record sets (DELETE of the listed
// set and CREATE of the union, keeping the set's TTL) and returns the records
// that were added.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	id, err := p.hostedZone(ctx, zone)
	if err != nil {
		return nil, err
	}
	var changes []change
	var added []libdns.Record
	for _, g := range groups(zone, records) {
		existing, err := p.list(ctx, id, g.fqdn, g.typ)
		if err != nil {
			return nil, err
		}
		if !allSimple(existing) {
			return nil, fmt.Errorf("%w: %s %s is an alias or routing-policy record set", dnsx.ErrUnsupported, g.fqdn, g.typ)
		}
		if len(existing) == 0 {
			values, ttl, kept := g.unique()
			changes = append(changes, change{"CREATE", setXML(g.fqdn, g.typ, ttl, values)})
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
		values := append([]string{}, current.Values...)
		var fresh []libdns.Record
		for _, r := range g.records {
			if key := dnsx.CanonicalData(g.typ, r.Data); !have[key] {
				have[key] = true
				values = append(values, encodeValue(g.typ, r.Data))
				fresh = append(fresh, dnsx.RR(r.Name, r.Type, r.Data, current.TTL))
			}
		}
		if len(fresh) == 0 {
			continue
		}
		changes = append(changes, change{"DELETE", current.Raw}, change{"CREATE", setXML(g.fqdn, g.typ, current.TTL, values)})
		added = append(added, fresh...)
	}
	if err := p.submit(ctx, id, changes); err != nil {
		return nil, err
	}
	return added, nil
}

// SetRecords makes each input record set exactly the input records: an
// UPSERT of the whole set, or DELETE of alias/routing-policy sets of the same
// name and type plus CREATE. Unchanged sets are not sent.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	id, err := p.hostedZone(ctx, zone)
	if err != nil {
		return nil, err
	}
	var changes []change
	var out []libdns.Record
	for _, g := range groups(zone, records) {
		existing, err := p.list(ctx, id, g.fqdn, g.typ)
		if err != nil {
			return nil, err
		}
		values, ttl, kept := g.unique()
		for _, r := range kept {
			out = append(out, dnsx.RR(r.Name, r.Type, r.Data, ttl))
		}
		wanted := setXML(g.fqdn, g.typ, ttl, values)
		switch {
		case len(existing) == 1 && existing[0].simple() && sameSet(existing[0], g.typ, ttl, kept, zone):
		case allSimple(existing):
			changes = append(changes, change{"UPSERT", wanted})
		default:
			for _, s := range existing {
				changes = append(changes, change{"DELETE", s.Raw})
			}
			changes = append(changes, change{"CREATE", wanted})
		}
	}
	if err := p.submit(ctx, id, changes); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteRecords removes matching records from simple record sets (data empty:
// the whole set) and returns them.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	id, err := p.hostedZone(ctx, zone)
	if err != nil {
		return nil, err
	}
	var changes []change
	var deleted []libdns.Record
	for _, g := range groups(zone, records) {
		existing, err := p.list(ctx, id, g.fqdn, g.typ)
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
					keep = append(keep, s.Values[i])
				}
			}
			if len(gone) == 0 {
				continue
			}
			changes = append(changes, change{"DELETE", s.Raw})
			if len(keep) > 0 {
				changes = append(changes, change{"CREATE", setXML(g.fqdn, g.typ, s.TTL, keep)})
			}
			deleted = append(deleted, gone...)
		}
	}
	if err := p.submit(ctx, id, changes); err != nil {
		return nil, err
	}
	return deleted, nil
}

// ListZones lists the account's public hosted zones.
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	query := [][2]string{{"maxitems", "100"}}
	var zones []libdns.Zone
	for page := 0; page < maxPages; page++ {
		var out zonesResponse
		if err := p.request(ctx, http.MethodGet, "/hostedzone", query, nil, &out); err != nil {
			return nil, err
		}
		for _, z := range out.Zones {
			if !z.Private {
				zones = append(zones, libdns.Zone{Name: unescapeName(z.Name)})
			}
		}
		if !out.Truncated || out.NextMarker == "" {
			return zones, nil
		}
		query = [][2]string{{"marker", out.NextMarker}, {"maxitems", "100"}}
	}
	return zones, nil
}

// escapeName writes a lowercase absolute name the way Route 53 stores it:
// characters other than a-z 0-9 - _ . as \ooo octal escapes ("*" is \052).
func escapeName(name string) string {
	var b strings.Builder
	for i := 0; i < len(name); i++ {
		c := name[i]
		if 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_' || c == '.' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "\\%03o", c)
		}
	}
	return b.String()
}

// unescapeName decodes \ooo escapes and returns the lowercase absolute name.
func unescapeName(name string) string {
	var b strings.Builder
	for i := 0; i < len(name); i++ {
		if name[i] == '\\' && i+3 < len(name) && isOctal(name[i+1]) && isOctal(name[i+2]) && isOctal(name[i+3]) {
			n, _ := strconv.ParseUint(name[i+1:i+4], 8, 16)
			b.WriteByte(byte(n))
			i += 3
			continue
		}
		b.WriteByte(name[i])
	}
	out := strings.ToLower(b.String())
	if !strings.HasSuffix(out, ".") {
		out += "."
	}
	return out
}

func isOctal(c byte) bool { return '0' <= c && c <= '7' }

// quoteTXT turns text into Route 53's TXT value: strings of at most 255
// bytes in double quotes, with \" \\ and \ooo escapes for other bytes
// outside printable ASCII (Developer Guide, "TXT record type").
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
				fmt.Fprintf(&b, "\\%03o", c)
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

// unquoteTXT concatenates the quoted strings of a TXT value.
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
			if i+3 < len(value) && isOctal(value[i+1]) && isOctal(value[i+2]) && isOctal(value[i+3]) {
				if n, err := strconv.ParseUint(value[i+1:i+4], 8, 8); err == nil {
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
