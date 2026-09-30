// Package powerdns is the adapter for the PowerDNS Authoritative Server HTTP
// API v1 (https://doc.powerdns.com/authoritative/http-api/): JSON with an
// X-API-Key header; a zone is read with GET .../zones/{zone_id} and changed
// one RRset at a time with PATCH .../zones/{zone_id} (changetype REPLACE or
// DELETE, applied in one transaction per request).
//
// The server is the user's own, so every connection goes through the
// outbound address policy (dnsx.Options.PolicyClient). The libdns/powerdns
// module is not used: it builds its go-powerdns client on http.DefaultClient
// and has no way to take the policy transport.
//
// Content conversion: PowerDNS stores hostnames absolute (trailing dot) and
// TXT in zone-file form ("..." "..."); records in and out use libdns form.
// Disabled records are not returned by GetRecords; AppendRecords and
// DeleteRecords keep them in the RRsets they rewrite.
package powerdns

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const maxRecords = 100000

// Provider talks to one PowerDNS server.
type Provider struct {
	server string // https://host:port/api/v1/servers/{server_id}
	key    string
	client *http.Client
	mu     sync.Mutex // Append and Delete read, merge and replace whole RRsets.
}

// New builds the adapter from the catalog fields (server_url, api_key,
// server_id).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	base, err := serverURL(fields["server_url"])
	if err != nil {
		return nil, err
	}
	key := fields["api_key"]
	if key == "" || strings.ContainsFunc(key, func(r rune) bool { return r < 0x21 || r == 0x7f }) {
		return nil, fmt.Errorf("%w: PowerDNS api_key must be non-empty without spaces or control characters", dnsx.ErrInvalid)
	}
	id := fields["server_id"]
	if id == "" {
		id = "localhost"
	}
	if !validServerID(id) {
		return nil, fmt.Errorf("%w: PowerDNS server_id may only contain letters, digits, '.', '_' and '-'", dnsx.ErrInvalid)
	}
	return &Provider{server: base + "/api/v1/servers/" + url.PathEscape(id), key: key, client: opts.PolicyClient()}, nil
}

// serverURL accepts scheme://host[:port] (http or https, no path, query,
// fragment or userinfo).
func serverURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Hostname() == "" ||
		u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("%w: PowerDNS server_url must be http(s)://host[:port] without path, query or credentials", dnsx.ErrInvalid)
	}
	if port := u.Port(); port != "" {
		if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
			return "", fmt.Errorf("%w: PowerDNS server_url has an invalid port", dnsx.ErrInvalid)
		}
	}
	return u.Scheme + "://" + u.Host, nil
}

func validServerID(id string) bool {
	if len(id) > 64 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// zoneID encodes a zone name the way the API does (apiZoneNameToId):
// characters other than letters, digits, '.' and '-' become =XX.
func zoneID(zone string) string {
	var b strings.Builder
	for _, c := range []byte(dnsx.Zone(zone) + ".") {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '-' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "=%02X", c)
		}
	}
	return b.String()
}

type record struct {
	Content  string `json:"content"`
	Disabled bool   `json:"disabled"`
}

type rrset struct {
	Name       string   `json:"name"`
	Type       string   `json:"type"`
	TTL        int      `json:"ttl,omitempty"`
	ChangeType string   `json:"changetype,omitempty"`
	Records    []record `json:"records,omitempty"`
}

type zoneDoc struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	RRsets []rrset `json:"rrsets"`
}

func (p *Provider) header() http.Header {
	return http.Header{"X-Api-Key": {p.key}, "User-Agent": {"edgeweir-certd/1"}}
}

// describe returns the API's {"error": "..."} text.
func describe(body []byte) string {
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil {
		return e.Error
	}
	return ""
}

func (p *Provider) zoneURL(zone string) string {
	return p.server + "/zones/" + url.PathEscape(zoneID(zone))
}

func (p *Provider) get(ctx context.Context, zone string) (*zoneDoc, error) {
	var doc zoneDoc
	if err := dnsx.JSON(ctx, p.client, http.MethodGet, p.zoneURL(zone), p.header(), nil, &doc, describe); err != nil {
		return nil, err
	}
	count := 0
	for _, set := range doc.RRsets {
		count += len(set.Records)
	}
	if count > maxRecords {
		return nil, fmt.Errorf("%w: PowerDNS zone exceeds %d records", dnsx.ErrProvider, maxRecords)
	}
	return &doc, nil
}

func (p *Provider) patch(ctx context.Context, zone string, sets []rrset) error {
	if len(sets) == 0 {
		return nil
	}
	return dnsx.JSON(ctx, p.client, http.MethodPatch, p.zoneURL(zone), p.header(), map[string]any{"rrsets": sets}, nil, describe)
}

// member is an existing RRset member: its libdns form and the content as
// PowerDNS stores it (written back unchanged).
type member struct {
	rr       libdns.RR
	content  string
	disabled bool
}

type existingSet struct {
	name, typ string // as PowerDNS returned them
	ttl       int
	members   []member
}

func index(doc *zoneDoc, zone string) (map[string]*existingSet, []string) {
	sets := map[string]*existingSet{}
	var order []string
	for _, s := range doc.RRsets {
		es := &existingSet{name: s.Name, typ: strings.ToUpper(s.Type), ttl: s.TTL}
		for _, r := range s.Records {
			es.members = append(es.members, member{rr: toRR(s, r, zone), content: r.Content, disabled: r.Disabled})
		}
		key := dnsx.SetKey(libdns.RR{Name: dnsx.Relative(s.Name, zone), Type: s.Type})
		if _, dup := sets[key]; !dup {
			order = append(order, key)
		}
		sets[key] = es
	}
	return sets, order
}

func toRR(s rrset, r record, zone string) libdns.RR {
	return dnsx.RR(dnsx.Relative(s.Name, zone), s.Type, fromContent(s.Type, r.Content), s.TTL)
}

// GetRecords returns the zone's enabled records.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	doc, err := p.get(ctx, zone)
	if err != nil {
		return nil, err
	}
	var out []libdns.Record
	for _, s := range doc.RRsets {
		for _, r := range s.Records {
			if !r.Disabled {
				out = append(out, toRR(s, r, zone))
			}
		}
	}
	return out, nil
}

// inputSet is one (name, type) of the input with its distinct members.
type inputSet struct {
	name, typ string
	members   []libdns.RR
}

func group(records []libdns.Record) ([]string, map[string]*inputSet) {
	var order []string
	sets := map[string]*inputSet{}
	seen := map[string]bool{}
	for _, r := range dnsx.RRs(records) {
		key := dnsx.SetKey(r)
		s, ok := sets[key]
		if !ok {
			s = &inputSet{name: r.Name, typ: strings.ToUpper(r.Type)}
			sets[key] = s
			order = append(order, key)
		}
		if !seen[dnsx.Key(r)] {
			seen[dnsx.Key(r)] = true
			s.members = append(s.members, r)
		}
	}
	return order, sets
}

func fqdn(name, zone string) string {
	return dnsx.FQDN(strings.ToLower(name), dnsx.Zone(zone)+".") + "."
}

func replace(name, typ string, ttl int, records []record) rrset {
	return rrset{Name: name, Type: typ, TTL: ttl, ChangeType: "REPLACE", Records: records}
}

// AppendRecords adds the records to their RRsets (REPLACE with the union of
// the existing and the new members; the RRset takes the input TTL).
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	doc, err := p.get(ctx, zone)
	if err != nil {
		return nil, err
	}
	existing, _ := index(doc, zone)
	order, input := group(records)
	var patch []rrset
	for _, key := range order {
		in := input[key]
		var members []record
		have := map[string]int{}
		if es := existing[key]; es != nil {
			for _, m := range es.members {
				have[dnsx.Key(m.rr)] = len(members)
				members = append(members, record{Content: m.content, Disabled: m.disabled})
			}
		}
		for _, r := range in.members {
			if i, ok := have[dnsx.Key(r)]; ok {
				members[i].Disabled = false
				continue
			}
			members = append(members, record{Content: toContent(in.typ, r.Data)})
		}
		patch = append(patch, replace(fqdn(in.name, zone), in.typ, dnsx.Seconds(in.members[0].TTL), members))
	}
	if err := p.patch(ctx, zone, patch); err != nil {
		return nil, err
	}
	return records, nil
}

// SetRecords replaces each input RRset with exactly the input records.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	order, input := group(records)
	var patch []rrset
	for _, key := range order {
		in := input[key]
		members := make([]record, 0, len(in.members))
		for _, r := range in.members {
			members = append(members, record{Content: toContent(in.typ, r.Data)})
		}
		patch = append(patch, replace(fqdn(in.name, zone), in.typ, dnsx.Seconds(in.members[0].TTL), members))
	}
	if err := p.patch(ctx, zone, patch); err != nil {
		return nil, err
	}
	return records, nil
}

// DeleteRecords removes the matching records (data empty: the whole RRset):
// REPLACE with the remaining members, DELETE when none remain.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	doc, err := p.get(ctx, zone)
	if err != nil {
		return nil, err
	}
	existing, order := index(doc, zone)
	input := dnsx.RRs(records)
	var patch []rrset
	var deleted []libdns.Record
	for _, key := range order {
		es := existing[key]
		var keep []record
		removed := false
		for _, m := range es.members {
			match := false
			for _, in := range input {
				if dnsx.Matches(m.rr, in) {
					match = true
					break
				}
			}
			if match {
				removed = true
				deleted = append(deleted, m.rr)
			} else {
				keep = append(keep, record{Content: m.content, Disabled: m.disabled})
			}
		}
		switch {
		case !removed:
		case len(keep) == 0:
			patch = append(patch, rrset{Name: es.name, Type: es.typ, ChangeType: "DELETE"})
		default:
			patch = append(patch, replace(es.name, es.typ, es.ttl, keep))
		}
	}
	if err := p.patch(ctx, zone, patch); err != nil {
		return nil, err
	}
	return deleted, nil
}

// ListZones lists the server's zones.
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var list []struct {
		Name string `json:"name"`
	}
	if err := dnsx.JSON(ctx, p.client, http.MethodGet, p.server+"/zones", p.header(), nil, &list, describe); err != nil {
		return nil, err
	}
	zones := make([]libdns.Zone, 0, len(list))
	for _, z := range list {
		if name := dnsx.Zone(z.Name); name != "" {
			zones = append(zones, libdns.Zone{Name: name + "."})
		}
	}
	return zones, nil
}

// hostTypes hold a single hostname that PowerDNS requires absolute.
var hostTypes = map[string]bool{"CNAME": true, "ALIAS": true, "NS": true, "PTR": true, "DNAME": true}

func toContent(typ, data string) string {
	typ = strings.ToUpper(typ)
	switch {
	case typ == "TXT" || typ == "SPF":
		return quoteTXT(data)
	case hostTypes[typ]:
		return strings.TrimSuffix(data, ".") + "."
	}
	return data
}

func fromContent(typ, content string) string {
	switch strings.ToUpper(typ) {
	case "TXT", "SPF":
		return unquoteTXT(content)
	}
	return content
}

// quoteTXT writes text in the form PowerDNS returns it: strings of at most
// 255 bytes, '"' and '\' escaped, bytes outside printable ASCII as \DDD.
func quoteTXT(text string) string {
	var b strings.Builder
	for first := true; first || text != ""; first = false {
		chunk := text
		if len(chunk) > 255 {
			chunk = chunk[:255]
		}
		text = text[len(chunk):]
		if !first {
			b.WriteByte(' ')
		}
		b.WriteByte('"')
		for i := 0; i < len(chunk); i++ {
			switch c := chunk[i]; {
			case c == '"' || c == '\\':
				b.WriteByte('\\')
				b.WriteByte(c)
			case c < 0x20 || c > 0x7e:
				fmt.Fprintf(&b, "\\%03d", c)
			default:
				b.WriteByte(c)
			}
		}
		b.WriteByte('"')
	}
	return b.String()
}

// unquoteTXT joins zone-file TXT strings, decoding \X and \DDD escapes.
// (dnsx.Unquote does not decode \DDD.)
func unquoteTXT(value string) string {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, `"`) {
		return value
	}
	out := make([]byte, 0, len(value))
	quoted := false
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c == '"':
			quoted = !quoted
		case !quoted:
		case c == '\\' && i+1 < len(value):
			if i+3 < len(value) && isDigit(value[i+1]) && isDigit(value[i+2]) && isDigit(value[i+3]) {
				if n := int(value[i+1]-'0')*100 + int(value[i+2]-'0')*10 + int(value[i+3]-'0'); n < 256 {
					out = append(out, byte(n))
					i += 3
					continue
				}
			}
			i++
			out = append(out, value[i])
		default:
			out = append(out, c)
		}
	}
	return string(out)
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }
