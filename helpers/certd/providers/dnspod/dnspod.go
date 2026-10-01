// Package dnspod is the DNSPod adapter for the classic token API
// (https://docs.dnspod.cn/api/): form-encoded POSTs authenticated with a
// login_token "ID,Token". The published libdns module predates libdns v1.
//
// The token API only accepts main-account tokens; DNSPod international
// (api.dnspod.com) is not supported: its legacy API needs domain IDs, uses
// English line names and other status codes, and has no service guarantee.
package dnspod

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	endpoint   = "https://dnsapi.cn"
	pageSize   = 3000 // documented maximum of length
	maxRecords = 100000
)

var tokenPattern = regexp.MustCompile(`^[0-9]{1,20},[0-9A-Za-z]{8,128}$`)

// Lines maps canonical lines to DNSPod line ids (record_line_id; the same
// ids as API 3.0, https://docs.dnspod.cn/dns/dns-record-line/). Requests
// send the id, which DNSPod prefers to the name (names were renamed over
// time).
var Lines = dnsx.LineMap{"default": "0", "telecom": "10=0", "unicom": "10=1", "mobile": "10=3", "edu": "10=2", "overseas": "3=0"}

// lineNames reads responses that carry a line name but no line_id.
var lineNames = map[string]string{
	"": "", "默认": "", "Default": "", "default": "",
	"电信": "telecom", "联通": "unicom", "移动": "mobile", "教育网": "edu", "境外": "overseas",
}

// Provider talks to one DNSPod account.
type Provider struct {
	Token   string
	BaseURL string
	Client  *http.Client
	mu      sync.Mutex // DNSPod applies changes per record; serialize writes per provider.
}

// New builds the adapter from the catalog fields (auth_token).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	token := fields["auth_token"]
	if !tokenPattern.MatchString(token) {
		return nil, fmt.Errorf("%w: DNSPod auth_token must be \"ID,Token\"", dnsx.ErrInvalid)
	}
	return &Provider{Token: token, BaseURL: opts.Endpoint(endpoint), Client: opts.Client()}, nil
}

type status struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type record struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Line   string `json:"line"`
	LineID string `json:"line_id"`
	Type   string `json:"type"`
	Value  string `json:"value"`
	TTL    string `json:"ttl"`
}

// count accepts a JSON number or a numeric string (DNSPod uses both).
type count int

func (c *count) UnmarshalJSON(b []byte) error {
	var n json.Number
	if err := json.Unmarshal(b, &n); err != nil {
		var s string
		if json.Unmarshal(b, &s) != nil {
			return nil
		}
		n = json.Number(s)
	}
	v, _ := strconv.Atoi(n.String())
	*c = count(v)
	return nil
}

type response struct {
	Status status `json:"status"`
	Info   struct {
		RecordTotal count `json:"record_total"`
		DomainTotal count `json:"domain_total"`
	} `json:"info"`
	Records []record `json:"records"`
	Domains []struct {
		Name     string `json:"name"`
		Punycode string `json:"punycode"`
	} `json:"domains"`
}

func (p *Provider) call(ctx context.Context, action string, fields url.Values, ok ...string) (*response, error) {
	fields.Set("login_token", p.Token)
	fields.Set("format", "json")
	fields.Set("lang", "en")
	fields.Set("error_on_empty", "no")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.BaseURL+"/"+action, strings.NewReader(fields.Encode()))
	if err != nil {
		return nil, fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "edgeweir-certd/1 (DNS records)")
	statusCode, body, err := dnsx.Do(p.Client, req)
	if err != nil {
		return nil, err
	}
	if statusCode != http.StatusOK {
		return nil, &dnsx.StatusError{Status: statusCode}
	}
	var out response
	if json.Unmarshal(body, &out) != nil {
		return nil, fmt.Errorf("%w: invalid DNSPod response", dnsx.ErrProvider)
	}
	if out.Status.Code == "1" {
		return &out, nil
	}
	for _, code := range ok {
		if out.Status.Code == code {
			return &out, nil
		}
	}
	return nil, p.apiError(action, out.Status)
}

// apiError maps DNSPod status codes: the common codes
// (https://docs.dnspod.cn/api/common-return/) and, for Record.* actions,
// the per-action codes naming an unknown or foreign domain
// (https://docs.dnspod.cn/api/record-list/, .../add-record/,
// .../modify-records/, .../delete-record/). Domain.List reuses 6-9 for
// paging errors, so those stay provider errors there.
func (p *Provider) apiError(action string, s status) error {
	kind := dnsx.ErrProvider
	switch s.Code {
	case "-1", "-7", "-8", "83", "85":
		kind = dnsx.ErrAuth // login failed, no API permission, locked after failed logins, account locked, login region refused
	case "-2":
		kind = dnsx.ErrRateLimited
	case "6", "7", "8", "9", "13":
		if strings.HasPrefix(action, "Record.") {
			kind = dnsx.ErrZoneNotFound // domain ID invalid, not the owner, domain invalid, not the owner (legacy), domain wrong
		}
	}
	message := dnsx.Short(s.Message)
	if _, secret, ok := strings.Cut(p.Token, ","); ok && secret != "" {
		message = strings.ReplaceAll(message, secret, "[token]")
	}
	return fmt.Errorf("%w: DNSPod %s status %s %s", kind, action, s.Code, message)
}

func (p *Provider) list(ctx context.Context, zone string) ([]record, error) {
	var all []record
	for offset := 0; offset <= maxRecords; {
		res, err := p.call(ctx, "Record.List", url.Values{
			"domain": {dnsx.Zone(zone)}, "offset": {strconv.Itoa(offset)}, "length": {strconv.Itoa(pageSize)},
		}, "10") // 10: the zone has no records
		if err != nil {
			return nil, err
		}
		all = append(all, res.Records...)
		offset += len(res.Records)
		total := int(res.Info.RecordTotal)
		if len(res.Records) == 0 || (total > 0 && offset >= total) || (total <= 0 && len(res.Records) < pageSize) {
			return all, nil
		}
	}
	return nil, fmt.Errorf("%w: DNSPod zone exceeds %d records", dnsx.ErrProvider, maxRecords)
}

func toRR(r record) libdns.RR {
	ttl, _ := strconv.Atoi(r.TTL)
	return dnsx.RR(r.Name, r.Type, r.Value, ttl)
}

// line returns the canonical line of a record: by line_id, else by name.
func (r record) line() string {
	if r.LineID != "" {
		return Lines.Canonical(r.LineID)
	}
	if line, ok := lineNames[r.Line]; ok {
		return line
	}
	return Lines.Canonical(r.Line)
}

func (r record) withLine() libdns.Record { return dnsx.OnLine(toRR(r), r.line()) }

// GetRecords lists every record of the zone (all lines, the system NS
// records included).
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	all, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	out := make([]libdns.Record, 0, len(all))
	for _, r := range all {
		out = append(out, r.withLine())
	}
	return out, nil
}

// write runs Record.Create (id empty) or Record.Modify on the record's line.
func (p *Provider) write(ctx context.Context, zone, id string, r dnsx.LineRecord) error {
	lineID, err := Lines.Provider(r.Line)
	if err != nil {
		return err
	}
	fields := url.Values{
		"domain": {dnsx.Zone(zone)}, "sub_domain": {r.Record.Name}, "record_type": {r.Record.Type},
		"record_line_id": {lineID}, "value": {r.Record.Data}, "ttl": {strconv.Itoa(dnsx.Seconds(r.Record.TTL))},
	}
	action := "Record.Create"
	if id != "" {
		action = "Record.Modify"
		fields.Set("record_id", id)
	}
	_, err = p.call(ctx, action, fields)
	return err
}

func (p *Provider) remove(ctx context.Context, zone string, id string) error {
	_, err := p.call(ctx, "Record.Remove", url.Values{"domain": {dnsx.Zone(zone)}, "record_id": {id}})
	return err
}

// AppendRecords creates the records on their lines.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	if err := Lines.Check(records); err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var done []libdns.Record
	for _, r := range records {
		if err := p.write(ctx, zone, "", dnsx.LineRecord{Record: r.RR(), Line: dnsx.LineOf(r)}); err != nil {
			return done, err
		}
		done = append(done, r)
	}
	return done, nil
}

// SetRecords makes each input (name, type) exactly the input records on
// every line: matching members are kept (TTL changes are rewritten),
// surplus members are rewritten in place to missing values on their line,
// the rest are created or removed; copies on lines the input does not use
// are removed.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	if err := Lines.Check(records); err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	existing, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	members := make([]dnsx.Member, 0, len(existing))
	for _, r := range existing {
		members = append(members, dnsx.Member{ID: r.ID, RR: toRR(r), Line: r.line()})
	}
	pl := dnsx.PlanSet(members, records)
	for _, u := range pl.Updates {
		if err := p.write(ctx, zone, u.ID, u.Record); err != nil {
			return nil, err
		}
	}
	for _, c := range pl.Creates {
		if err := p.write(ctx, zone, "", c); err != nil {
			return nil, err
		}
	}
	for _, d := range pl.Deletes {
		if err := p.remove(ctx, zone, d.ID); err != nil {
			return nil, err
		}
	}
	return pl.Result(nil), nil
}

// DeleteRecords removes the matching records on the input's line (data
// empty: the whole RRset on that line).
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	existing, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	var deleted []libdns.Record
	for _, old := range existing {
		have := old.withLine()
		for _, in := range records {
			if dnsx.MatchesOnLine(have, in) {
				if err := p.remove(ctx, zone, old.ID); err != nil {
					return deleted, err
				}
				deleted = append(deleted, have)
				break
			}
		}
	}
	return deleted, nil
}

// ListZones lists the account's domains (punycode names).
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var zones []libdns.Zone
	for offset := 0; offset <= maxRecords; {
		res, err := p.call(ctx, "Domain.List", url.Values{"type": {"all"}, "offset": {strconv.Itoa(offset)}, "length": {strconv.Itoa(pageSize)}}, "9") // 9: no domains
		if err != nil {
			return nil, err
		}
		for _, d := range res.Domains {
			name := d.Punycode
			if name == "" {
				name = d.Name
			}
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(name) + "."})
		}
		offset += len(res.Domains)
		total := int(res.Info.DomainTotal)
		if len(res.Domains) == 0 || (total > 0 && offset >= total) || (total <= 0 && len(res.Domains) < pageSize) {
			return zones, nil
		}
	}
	return nil, fmt.Errorf("%w: DNSPod account exceeds %d domains", dnsx.ErrProvider, maxRecords)
}
