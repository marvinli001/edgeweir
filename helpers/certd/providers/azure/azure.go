// Package azure is the Azure DNS adapter: Azure Resource Manager record sets
// (https://learn.microsoft.com/rest/api/dns/, api-version 2018-05-01, the
// current stable version) with a Microsoft Entra ID client secret (OAuth 2.0
// client credentials), written with the standard library because the libdns
// module pulls the Azure SDK.
//
// Azure keeps one record set per name and type. Writes PUT or DELETE the
// whole record set with If-Match (the etag that was read) or If-None-Match: *
// (a new set), so a concurrent change fails with 412 instead of being
// overwritten; record sets are written one at a time (no batch API). Alias
// record sets (targetResource) are skipped by GetRecords, refused by
// AppendRecords, left alone by DeleteRecords and replaced by SetRecords.
package azure

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/netip"
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

const (
	armEndpoint   = "https://management.azure.com"
	loginEndpoint = "https://login.microsoftonline.com"
	scope         = "https://management.azure.com/.default"
	apiVersion    = "2018-05-01"
	maxRecords    = 100000
	maxPages      = 2000
)

var (
	guidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	// A tenant is a GUID or a verified domain ("contoso.onmicrosoft.com").
	tenantDomainPattern = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$`)
	// Resource group names: letters, digits, underscores, parentheses,
	// hyphens and periods, 1-90 characters, not ending in a period.
	groupPattern = regexp.MustCompile(`^[A-Za-z0-9_().-]{0,89}[A-Za-z0-9_()-]$`)
	// Zone and relative record set names go into the path unescaped, as the
	// Azure SDK sends them (x-ms-skip-url-encoding), so they are restricted
	// to DNS name characters.
	zoneNamePattern   = regexp.MustCompile(`^[a-z0-9_-]+(\.[a-z0-9_-]+)+$`)
	recordNamePattern = regexp.MustCompile(`^(@|\*|(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)*)$`)
)

// Provider talks to Azure DNS as one service principal.
type Provider struct {
	tenant, clientID, secret string
	subscription, group      string
	apiURL, tokenURL         string
	client                   *http.Client
	now                      func() time.Time
	mu                       sync.Mutex // serializes read-modify-write of record sets
	tmu                      sync.Mutex
	token                    string
	expiry                   time.Time
	zmu                      sync.Mutex
	zones                    map[string]bool // zones seen to exist
}

// New builds the adapter from the catalog fields (tenant_id, client_id,
// client_secret, subscription_id, resource_group). Every value that ends up
// in a URL is checked so it cannot add path segments or change the host.
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	tenant := strings.TrimSpace(fields["tenant_id"])
	clientID := strings.TrimSpace(fields["client_id"])
	secret := fields["client_secret"]
	subscription := strings.TrimSpace(fields["subscription_id"])
	group := strings.TrimSpace(fields["resource_group"])
	switch {
	case !guidPattern.MatchString(tenant) && !tenantDomainPattern.MatchString(tenant):
		return nil, fmt.Errorf("%w: Azure tenant_id must be a GUID or a tenant domain", dnsx.ErrInvalid)
	case !guidPattern.MatchString(clientID):
		return nil, fmt.Errorf("%w: Azure client_id must be a GUID", dnsx.ErrInvalid)
	case !printable(secret, 1, 1024):
		return nil, fmt.Errorf("%w: Azure client_secret is malformed", dnsx.ErrInvalid)
	case !guidPattern.MatchString(subscription):
		return nil, fmt.Errorf("%w: Azure subscription_id must be a GUID", dnsx.ErrInvalid)
	case !groupPattern.MatchString(group):
		return nil, fmt.Errorf("%w: Azure resource_group is malformed", dnsx.ErrInvalid)
	}
	return &Provider{
		tenant: tenant, clientID: clientID, secret: secret, subscription: subscription, group: group,
		apiURL:   opts.Endpoint(armEndpoint),
		tokenURL: opts.Endpoint(loginEndpoint) + "/" + url.PathEscape(tenant) + "/oauth2/v2.0/token",
		client:   opts.Client(), now: time.Now, zones: map[string]bool{},
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

func (p *Provider) redact(text string) string {
	return strings.ReplaceAll(text, p.secret, "[redacted]")
}

// accessToken returns a cached access token or gets a new one
// (https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow).
func (p *Provider) accessToken(ctx context.Context) (string, error) {
	p.tmu.Lock()
	defer p.tmu.Unlock()
	now := p.now()
	if p.token != "" && now.Before(p.expiry) {
		return p.token, nil
	}
	form := url.Values{"client_id": {p.clientID}, "client_secret": {p.secret}, "scope": {scope}, "grant_type": {"client_credentials"}}
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
		// The description's first line holds the AADSTS code and reason; the
		// rest are trace and correlation IDs.
		description, _, _ := strings.Cut(e.Description, "\r\n")
		text := dnsx.Short(p.redact(strings.TrimSpace(e.Error + " " + description)))
		switch {
		case status == http.StatusTooManyRequests:
			return "", fmt.Errorf("%w: Microsoft Entra ID %s", dnsx.ErrRateLimited, text)
		case status >= 500:
			return "", &dnsx.StatusError{Status: status, Message: "Microsoft Entra ID " + text}
		default: // invalid_client, unauthorized_client, invalid_request (unknown tenant), ...
			return "", fmt.Errorf("%w: Microsoft Entra ID %s", dnsx.ErrAuth, text)
		}
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if json.Unmarshal(body, &out) != nil || out.AccessToken == "" {
		return "", fmt.Errorf("%w: invalid Microsoft Entra ID response", dnsx.ErrProvider)
	}
	p.token = out.AccessToken
	p.expiry = now.Add(time.Duration(max(out.ExpiresIn-60, 0)) * time.Second)
	return p.token, nil
}

// armError maps Azure Resource Manager errors ({"error":{"code","message"}}).
func (p *Provider) armError(status int, body []byte) error {
	var e struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &e)
	text := dnsx.Short(p.redact(strings.TrimSpace(e.Error.Code + " " + e.Error.Message)))
	switch e.Error.Code {
	case "ResourceNotFound", "ParentResourceNotFound", "ResourceGroupNotFound", "SubscriptionNotFound":
		return fmt.Errorf("%w: Azure %s", dnsx.ErrZoneNotFound, text)
	}
	return &dnsx.StatusError{Status: status, Message: "Azure " + text}
}

// call sends a request to an absolute ARM URL and returns the status; 404 is
// returned without error when allow404 is set.
func (p *Provider) call(ctx context.Context, method, target string, header map[string]string, in, out any, allow404 bool) (int, error) {
	token, err := p.accessToken(ctx)
	if err != nil {
		return 0, err
	}
	var reader io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return 0, fmt.Errorf("%w: encoding request", dnsx.ErrInvalid)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return 0, fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "edgeweir-certd/1")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	status, raw, err := dnsx.Do(p.client, req)
	if err != nil {
		return 0, err
	}
	if status == http.StatusNotFound && allow404 {
		return status, nil
	}
	if status < 200 || status > 299 {
		return status, p.armError(status, raw)
	}
	if out != nil && status != http.StatusNoContent && json.Unmarshal(raw, out) != nil {
		return status, fmt.Errorf("%w: invalid Azure response", dnsx.ErrProvider)
	}
	return status, nil
}

func (p *Provider) groupPath() string {
	return "/subscriptions/" + url.PathEscape(p.subscription) + "/resourceGroups/" + url.PathEscape(p.group) + "/providers/Microsoft.Network/dnsZones"
}

func (p *Provider) target(path string) string {
	return p.apiURL + path + "?api-version=" + apiVersion
}

func (p *Provider) zonePath(zone string) string {
	return p.groupPath() + "/" + dnsx.Zone(zone)
}

func checkZone(zone string) error {
	if !zoneNamePattern.MatchString(dnsx.Zone(zone)) {
		return fmt.Errorf("%w: zone name %q", dnsx.ErrInvalid, dnsx.Zone(zone))
	}
	return nil
}

// next accepts a nextLink only on the API's own scheme and host, inside this
// resource group (ARM paths are case-insensitive).
func (p *Provider) next(link string) (string, error) {
	base, _ := url.Parse(p.apiURL)
	u, err := url.Parse(link)
	prefix := strings.ToLower("/subscriptions/" + p.subscription + "/resourceGroups/" + p.group + "/providers/Microsoft.Network/dnsZones")
	if err != nil || u.Scheme != base.Scheme || u.Host != base.Host || u.User != nil || !strings.HasPrefix(strings.ToLower(u.Path), prefix) {
		return "", fmt.Errorf("%w: Azure nextLink leaves the resource group", dnsx.ErrProvider)
	}
	return u.String(), nil
}

// ensureZone checks once that the public zone exists in the resource group.
func (p *Provider) ensureZone(ctx context.Context, zone string) error {
	if err := checkZone(zone); err != nil {
		return err
	}
	p.zmu.Lock()
	defer p.zmu.Unlock()
	if p.zones[dnsx.Zone(zone)] {
		return nil
	}
	var out struct {
		Properties struct {
			ZoneType string `json:"zoneType"`
		} `json:"properties"`
	}
	if _, err := p.call(ctx, http.MethodGet, p.target(p.zonePath(zone)), nil, nil, &out, false); err != nil {
		return err
	}
	if strings.EqualFold(out.Properties.ZoneType, "Private") {
		return fmt.Errorf("%w: Azure zone %s is private", dnsx.ErrZoneNotFound, dnsx.Zone(zone))
	}
	p.zones[dnsx.Zone(zone)] = true
	return nil
}

type recordSet struct {
	Name       string                     `json:"name"`
	Type       string                     `json:"type"` // Microsoft.Network/dnszones/A
	Etag       string                     `json:"etag"`
	Properties map[string]json.RawMessage `json:"properties"`
}

// prop returns a property by case-insensitive name.
func (s recordSet) prop(name string) json.RawMessage {
	for k, v := range s.Properties {
		if strings.EqualFold(k, name) {
			return v
		}
	}
	return nil
}

func (s recordSet) kind() string {
	return strings.ToUpper(s.Type[strings.LastIndex(s.Type, "/")+1:])
}

func (s recordSet) ttl() int {
	n, _ := strconv.Atoi(string(s.prop("TTL")))
	return n
}

func (s recordSet) alias() bool {
	var target struct {
		ID string `json:"id"`
	}
	return json.Unmarshal(s.prop("targetResource"), &target) == nil && target.ID != ""
}

// Property names of the record arrays (CNAME and SOA hold one object).
var recordKeys = map[string]string{
	"A": "ARecords", "AAAA": "AAAARecords", "CNAME": "CNAMERecord", "TXT": "TXTRecords", "MX": "MXRecords",
	"NS": "NSRecords", "PTR": "PTRRecords", "SRV": "SRVRecords", "CAA": "caaRecords", "SOA": "SOARecord",
}

// entry is one record: its data in zone-file form and its ARM object.
type entry struct {
	data string
	raw  json.RawMessage
}

func (s recordSet) entries() []entry {
	typ := s.kind()
	raw := s.prop(recordKeys[typ])
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var items []json.RawMessage
	if typ == "CNAME" || typ == "SOA" {
		items = []json.RawMessage{raw}
	} else if json.Unmarshal(raw, &items) != nil {
		return nil
	}
	var out []entry
	for _, item := range items {
		var r struct {
			IPv4       string `json:"ipv4Address"`
			IPv6       string `json:"ipv6Address"`
			Cname      string `json:"cname"`
			Value      any    `json:"value"` // TXT: strings; CAA: string
			Preference int    `json:"preference"`
			Exchange   string `json:"exchange"`
			Nsdname    string `json:"nsdname"`
			Ptrdname   string `json:"ptrdname"`
			Priority   int    `json:"priority"`
			Weight     int    `json:"weight"`
			Port       int    `json:"port"`
			Target     string `json:"target"`
			Flags      int    `json:"flags"`
			Tag        string `json:"tag"`
			Host       string `json:"host"`
			Email      string `json:"email"`
			Serial     int64  `json:"serialNumber"`
			Refresh    int64  `json:"refreshTime"`
			Retry      int64  `json:"retryTime"`
			Expire     int64  `json:"expireTime"`
			Minimum    int64  `json:"minimumTTL"`
		}
		if json.Unmarshal(item, &r) != nil {
			continue
		}
		var data string
		switch typ {
		case "A":
			data = r.IPv4
		case "AAAA":
			data = r.IPv6
		case "CNAME":
			data = r.Cname
		case "TXT":
			if parts, ok := r.Value.([]any); ok {
				for _, part := range parts {
					s, _ := part.(string)
					data += s
				}
			}
		case "MX":
			data = fmt.Sprintf("%d %s", r.Preference, r.Exchange)
		case "NS":
			data = r.Nsdname
		case "PTR":
			data = r.Ptrdname
		case "SRV":
			data = fmt.Sprintf("%d %d %d %s", r.Priority, r.Weight, r.Port, r.Target)
		case "CAA":
			value, _ := r.Value.(string)
			data = fmt.Sprintf("%d %s %q", r.Flags, r.Tag, value)
		case "SOA":
			data = fmt.Sprintf("%s %s %d %d %d %d %d", r.Host, r.Email, r.Serial, r.Refresh, r.Retry, r.Expire, r.Minimum)
		}
		out = append(out, entry{data: data, raw: item})
	}
	return out
}

// newEntry builds the ARM object of an input record (A, AAAA, CNAME, TXT).
func newEntry(typ, data string) (json.RawMessage, error) {
	var v any
	switch typ {
	case "A", "AAAA":
		ip, err := netip.ParseAddr(data)
		if err != nil || ip.Is4() != (typ == "A") {
			return nil, fmt.Errorf("%w: %s data must be an address of that family", dnsx.ErrInvalid, typ)
		}
		if typ == "A" {
			v = map[string]string{"ipv4Address": ip.String()}
		} else {
			v = map[string]string{"ipv6Address": ip.String()}
		}
	case "CNAME":
		v = map[string]string{"cname": strings.TrimSuffix(data, ".")}
	case "TXT":
		// The REST API takes each string (at most 255 bytes, split between
		// characters) of a TXT record separately.
		parts := []string{}
		for first := true; first || data != ""; first = false {
			n := min(255, len(data))
			for n < len(data) && n > 0 && !utf8.RuneStart(data[n]) {
				n--
			}
			parts = append(parts, data[:n])
			data = data[n:]
		}
		v = map[string][]string{"value": parts}
	default:
		return nil, fmt.Errorf("%w: Azure adapter writes A, AAAA, CNAME and TXT records", dnsx.ErrUnsupported)
	}
	raw, _ := json.Marshal(v)
	return raw, nil
}

// body is a record set PUT body; metadata of the replaced set is kept.
func body(typ string, ttl int, items []json.RawMessage, previous *recordSet) (any, error) {
	props := map[string]any{"TTL": ttl}
	if typ == "CNAME" {
		if len(items) != 1 {
			return nil, fmt.Errorf("%w: a CNAME record set holds one record", dnsx.ErrInvalid)
		}
		props[recordKeys[typ]] = items[0]
	} else {
		props[recordKeys[typ]] = items
	}
	if previous != nil {
		if m := previous.prop("metadata"); len(m) > 0 && string(m) != "null" {
			props["metadata"] = m
		}
	}
	return map[string]any{"properties": props}, nil
}

func toRRs(s recordSet, zone string) []libdns.RR {
	name := dnsx.Name(s.Name, zone)
	var out []libdns.RR
	for _, e := range s.entries() {
		out = append(out, dnsx.RR(name, s.kind(), e.data, s.ttl()))
	}
	return out
}

// GetRecords lists the records of every record set that is not an alias.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	if err := p.ensureZone(ctx, zone); err != nil {
		return nil, err
	}
	target := p.target(p.zonePath(zone) + "/all")
	var out []libdns.Record
	for page := 0; page < maxPages; page++ {
		var list struct {
			Value    []recordSet `json:"value"`
			NextLink string      `json:"nextLink"`
		}
		if _, err := p.call(ctx, http.MethodGet, target, nil, nil, &list, false); err != nil {
			return nil, err
		}
		for _, s := range list.Value {
			if s.alias() {
				continue
			}
			for _, rr := range toRRs(s, zone) {
				out = append(out, rr)
			}
		}
		if len(out) > maxRecords {
			return nil, fmt.Errorf("%w: Azure zone exceeds %d records", dnsx.ErrProvider, maxRecords)
		}
		if list.NextLink == "" {
			return out, nil
		}
		next, err := p.next(list.NextLink)
		if err != nil {
			return nil, err
		}
		target = next
	}
	return nil, fmt.Errorf("%w: Azure listing does not end", dnsx.ErrProvider)
}

// group is the input for one record set.
type group struct {
	name, typ string // relative name, type
	records   []libdns.RR
}

func groups(zone string, records []libdns.Record) []*group {
	var out []*group
	index := map[string]*group{}
	for _, r := range dnsx.RRs(records) {
		r.Name = dnsx.Relative(dnsx.FQDN(r.Name, zone), zone)
		r.Type = strings.ToUpper(r.Type)
		key := r.Name + "\x00" + r.Type
		g := index[key]
		if g == nil {
			g = &group{name: r.Name, typ: r.Type}
			index[key] = g
			out = append(out, g)
		}
		g.records = append(g.records, r)
	}
	return out
}

// unique drops duplicate data and returns the ARM objects and the smallest
// TTL (a record set has one TTL).
func (g *group) unique() (items []json.RawMessage, ttl int, kept []libdns.RR, err error) {
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
		item, err := newEntry(g.typ, r.Data)
		if err != nil {
			return nil, 0, nil, err
		}
		items = append(items, item)
		kept = append(kept, r)
	}
	return items, ttl, kept, nil
}

func (p *Provider) setPath(zone, typ, name string) string {
	return p.zonePath(zone) + "/" + typ + "/" + name
}

// get returns the record set, or nil when it does not exist.
func (p *Provider) get(ctx context.Context, zone, typ, name string) (*recordSet, error) {
	if _, ok := recordKeys[typ]; !ok {
		return nil, fmt.Errorf("%w: Azure DNS has no %s records", dnsx.ErrUnsupported, typ)
	}
	if !recordNamePattern.MatchString(name) {
		return nil, fmt.Errorf("%w: record name %q", dnsx.ErrInvalid, name)
	}
	var s recordSet
	status, err := p.call(ctx, http.MethodGet, p.target(p.setPath(zone, typ, name)), nil, nil, &s, true)
	if err != nil || status == http.StatusNotFound {
		return nil, err
	}
	return &s, nil
}

// put writes a record set: If-Match the etag that was read, or
// If-None-Match: * for a new set.
func (p *Provider) put(ctx context.Context, zone string, g *group, previous *recordSet, payload any) error {
	header := map[string]string{"If-None-Match": "*"}
	if previous != nil {
		header = map[string]string{"If-Match": previous.Etag}
	}
	_, err := p.call(ctx, http.MethodPut, p.target(p.setPath(zone, g.typ, g.name)), header, payload, nil, false)
	return err
}

// AppendRecords adds the records to their record sets (keeping the set's
// TTL) and returns the records that were added.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.ensureZone(ctx, zone); err != nil {
		return nil, err
	}
	var added []libdns.Record
	for _, g := range groups(zone, records) {
		current, err := p.get(ctx, zone, g.typ, g.name)
		if err != nil {
			return added, err
		}
		if current == nil {
			items, ttl, kept, err := g.unique()
			if err != nil {
				return added, err
			}
			payload, err := body(g.typ, ttl, items, nil)
			if err == nil {
				err = p.put(ctx, zone, g, nil, payload)
			}
			if err != nil {
				return added, err
			}
			for _, r := range kept {
				added = append(added, dnsx.RR(r.Name, r.Type, r.Data, ttl))
			}
			continue
		}
		if current.alias() {
			return added, fmt.Errorf("%w: %s %s is an alias record set", dnsx.ErrUnsupported, g.name, g.typ)
		}
		have := map[string]bool{}
		var items []json.RawMessage
		for _, e := range current.entries() {
			have[dnsx.CanonicalData(g.typ, e.data)] = true
			items = append(items, e.raw)
		}
		var fresh []libdns.Record
		for _, r := range g.records {
			key := dnsx.CanonicalData(g.typ, r.Data)
			if have[key] {
				continue
			}
			item, err := newEntry(g.typ, r.Data)
			if err != nil {
				return added, err
			}
			have[key] = true
			items = append(items, item)
			fresh = append(fresh, dnsx.RR(r.Name, r.Type, r.Data, current.ttl()))
		}
		if len(fresh) == 0 {
			continue
		}
		payload, err := body(g.typ, current.ttl(), items, current)
		if err == nil {
			err = p.put(ctx, zone, g, current, payload)
		}
		if err != nil {
			return added, err
		}
		added = append(added, fresh...)
	}
	return added, nil
}

// SetRecords PUTs each input record set whole (alias sets of the same name
// and type are replaced). Unchanged sets are not written.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.ensureZone(ctx, zone); err != nil {
		return nil, err
	}
	var out []libdns.Record
	for _, g := range groups(zone, records) {
		items, ttl, kept, err := g.unique()
		if err != nil {
			return nil, err
		}
		current, err := p.get(ctx, zone, g.typ, g.name)
		if err != nil {
			return nil, err
		}
		for _, r := range kept {
			out = append(out, dnsx.RR(r.Name, r.Type, r.Data, ttl))
		}
		if current != nil && !current.alias() && current.ttl() == ttl && sameData(g.typ, current.entries(), kept) {
			continue
		}
		payload, err := body(g.typ, ttl, items, current)
		if err == nil {
			err = p.put(ctx, zone, g, current, payload)
		}
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func sameData(typ string, entries []entry, records []libdns.RR) bool {
	have := map[string]bool{}
	for _, e := range entries {
		have[dnsx.CanonicalData(typ, e.data)] = true
	}
	if len(have) != len(records) || len(entries) != len(records) {
		return false
	}
	for _, r := range records {
		if !have[dnsx.CanonicalData(typ, r.Data)] {
			return false
		}
	}
	return true
}

// DeleteRecords removes matching records (data empty: the whole set): the
// remaining records are written back, an emptied set is deleted.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.ensureZone(ctx, zone); err != nil {
		return nil, err
	}
	var deleted []libdns.Record
	for _, g := range groups(zone, records) {
		current, err := p.get(ctx, zone, g.typ, g.name)
		if err != nil {
			return deleted, err
		}
		if current == nil || current.alias() {
			continue
		}
		var keep []json.RawMessage
		var gone []libdns.Record
		for _, e := range current.entries() {
			rr := dnsx.RR(g.name, g.typ, e.data, current.ttl())
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
				keep = append(keep, e.raw)
			}
		}
		if len(gone) == 0 {
			continue
		}
		if len(keep) == 0 {
			_, err = p.call(ctx, http.MethodDelete, p.target(p.setPath(zone, g.typ, g.name)), map[string]string{"If-Match": current.Etag}, nil, nil, false)
		} else {
			var payload any
			if payload, err = body(g.typ, current.ttl(), keep, current); err == nil {
				err = p.put(ctx, zone, g, current, payload)
			}
		}
		if err != nil {
			return deleted, err
		}
		deleted = append(deleted, gone...)
	}
	return deleted, nil
}

// ListZones lists the public zones of the resource group.
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	target := p.target(p.groupPath())
	var zones []libdns.Zone
	for page := 0; page < maxPages; page++ {
		var list struct {
			Value []struct {
				Name       string `json:"name"`
				Properties struct {
					ZoneType string `json:"zoneType"`
				} `json:"properties"`
			} `json:"value"`
			NextLink string `json:"nextLink"`
		}
		if _, err := p.call(ctx, http.MethodGet, target, nil, nil, &list, false); err != nil {
			return nil, err
		}
		for _, z := range list.Value {
			if !strings.EqualFold(z.Properties.ZoneType, "Private") {
				zones = append(zones, libdns.Zone{Name: dnsx.Zone(z.Name) + "."})
			}
		}
		if list.NextLink == "" {
			return zones, nil
		}
		next, err := p.next(list.NextLink)
		if err != nil {
			return nil, err
		}
		target = next
	}
	return zones, nil
}
