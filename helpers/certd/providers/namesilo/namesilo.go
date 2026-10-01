// Package namesilo is the NameSilo adapter for the Domain API
// (https://www.namesilo.com/api-reference): GET requests with the API key in
// the query string and JSON replies carrying a reply code (300 = success).
//
// The published libdns module (github.com/libdns/namesilo v1.1.1) updates
// only the first member of an RRset in SetRecords, fails DeleteRecords for
// missing records, never exposes record IDs and sends the key through
// http.DefaultClient (redirects followed, no timeout, transport errors that
// quote the URL with the key), so this adapter calls the API directly.
package namesilo

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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

const endpoint = "https://www.namesilo.com/api"

// MinTTL is NameSilo's smallest TTL; shorter requested TTLs are raised to it.
const MinTTL = 3600

var keyPattern = regexp.MustCompile(`^[A-Za-z0-9]{8,128}$`)

// Provider talks to one NameSilo account.
type Provider struct {
	key     string
	baseURL string
	client  *http.Client
	mu      sync.Mutex // record changes are read-modify-write; serialize them
}

// New builds the adapter from the catalog fields (api_token).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	key := fields["api_token"]
	if !keyPattern.MatchString(key) {
		return nil, fmt.Errorf("%w: NameSilo api_token must be the alphanumeric API key", dnsx.ErrInvalid)
	}
	return &Provider{key: key, baseURL: opts.Endpoint(endpoint), client: opts.Client()}, nil
}

// flexInt decodes a number sent either as a JSON number or as a string.
type flexInt int

func (n *flexInt) UnmarshalJSON(data []byte) error {
	text := strings.Trim(string(data), `"`)
	if text == "" || text == "null" {
		*n = 0
		return nil
	}
	v, err := strconv.Atoi(text)
	*n = flexInt(v)
	return err
}

type record struct {
	ID       string  `json:"record_id"`
	Type     string  `json:"type"`
	Host     string  `json:"host"`
	Value    string  `json:"value"`
	TTL      flexInt `json:"ttl"`
	Distance flexInt `json:"distance"`
}

// records holds resource_record, which NameSilo sends as an array, as a bare
// object for a single record, or not at all for an empty zone.
type records []record

func (l *records) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) > 0 && data[0] == '{' {
		var one record
		if err := json.Unmarshal(data, &one); err != nil {
			return err
		}
		*l = records{one}
		return nil
	}
	var many []record
	if err := json.Unmarshal(data, &many); err != nil {
		return err
	}
	*l = many
	return nil
}

// domains holds listDomains' "domains": an array of {"domain": name}
// objects (current reference) or the older {"domain": name | [names]}.
type domains []string

func (d *domains) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	var objects []struct {
		Domain string `json:"domain"`
	}
	if json.Unmarshal(data, &objects) == nil {
		for _, o := range objects {
			*d = append(*d, o.Domain)
		}
		return nil
	}
	var names []string
	if json.Unmarshal(data, &names) == nil {
		*d = append(*d, names...)
		return nil
	}
	var legacy struct {
		Domain json.RawMessage `json:"domain"`
	}
	if err := json.Unmarshal(data, &legacy); err != nil {
		return err
	}
	var one string
	if json.Unmarshal(legacy.Domain, &one) == nil {
		*d = append(*d, one)
		return nil
	}
	if err := json.Unmarshal(legacy.Domain, &names); err != nil {
		return err
	}
	*d = append(*d, names...)
	return nil
}

type reply struct {
	Code     flexInt `json:"code"`
	Detail   string  `json:"detail"`
	RecordID string  `json:"record_id"`
	Records  records `json:"resource_record"`
	Domains  domains `json:"domains"`
	Pager    *struct {
		Page     flexInt `json:"page"`
		PageSize flexInt `json:"pageSize"`
		Total    flexInt `json:"total"`
	} `json:"pager"`
}

// call runs one operation. The request URL carries the key, so it never
// appears in errors (dnsx.Do drops it from transport errors); redirects are
// not followed (opts.Client).
func (p *Provider) call(ctx context.Context, operation string, params url.Values) (*reply, error) {
	params.Set("version", "1")
	params.Set("type", "json")
	params.Set("key", p.key)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.baseURL+"/"+operation+"?"+params.Encode(), nil)
	if err != nil {
		return nil, fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "edgeweir-certd/1")
	status, body, err := dnsx.Do(p.client, req)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, &dnsx.StatusError{Status: status}
	}
	var out struct {
		Reply reply `json:"reply"`
	}
	if json.Unmarshal(body, &out) != nil {
		return nil, fmt.Errorf("%w: invalid NameSilo response", dnsx.ErrProvider)
	}
	if out.Reply.Code != 300 {
		return nil, p.apiError(operation, out.Reply)
	}
	return &out.Reply, nil
}

// apiError maps NameSilo reply codes (api-reference "Response Codes").
func (p *Provider) apiError(operation string, r reply) error {
	kind := dnsx.ErrProvider
	switch r.Code {
	case 109, 110, 111, 112, 113, 120:
		kind = dnsx.ErrAuth // no key, invalid key, invalid user, sub-account, IP not allowed, key not in GET
	case 200:
		kind = dnsx.ErrZoneNotFound // domain not active or not owned by this user
	case 400:
		kind = dnsx.ErrRateLimited // an earlier request of this key is still processing
	case 115, 201:
		kind = dnsx.ErrUnreachable // registry not responding, internal system error
	case 108, 114:
		kind = dnsx.ErrInvalid // missing parameters, invalid domain syntax
	}
	detail := strings.ReplaceAll(dnsx.Short(r.Detail), p.key, "***")
	return fmt.Errorf("%w: NameSilo %s code %d %s", kind, operation, r.Code, detail)
}

func (p *Provider) list(ctx context.Context, zone string) ([]record, error) {
	res, err := p.call(ctx, "dnsListRecords", url.Values{"domain": {dnsx.Zone(zone)}})
	if err != nil {
		return nil, err
	}
	if len(res.Records) > 100000 {
		return nil, fmt.Errorf("%w: NameSilo zone exceeds 100000 records", dnsx.ErrProvider)
	}
	return res.Records, nil
}

func toRR(r record, zone string) libdns.RR {
	typ := strings.ToUpper(r.Type)
	data := r.Value
	switch typ {
	case "TXT":
		data = dnsx.Unquote(data)
	case "MX":
		data = fmt.Sprintf("%d %s", r.Distance, r.Value)
	}
	return dnsx.RR(dnsx.Relative(r.Host, zone), typ, data, int(r.TTL))
}

// input validates a write and applies the TTL minimum.
func input(records []libdns.Record) ([]libdns.RR, error) {
	out := make([]libdns.RR, 0, len(records))
	for _, r := range dnsx.RRs(records) {
		r.Type = strings.ToUpper(r.Type)
		switch r.Type {
		case "A", "AAAA", "CNAME", "TXT":
		default:
			return nil, fmt.Errorf("%w: NameSilo adapter writes A, AAAA, CNAME and TXT records", dnsx.ErrUnsupported)
		}
		if r.Name == "" {
			return nil, fmt.Errorf("%w: record name is empty", dnsx.ErrInvalid)
		}
		r.TTL = time.Duration(max(dnsx.Seconds(r.TTL), MinTTL)) * time.Second
		out = append(out, r)
	}
	return out, nil
}

// fields are the rrhost/rrvalue/rrttl parameters: host relative to the zone
// ("" for the apex), hostnames without the trailing dot NameSilo rejects.
func fields(r libdns.RR) url.Values {
	host := r.Name
	if host == "@" {
		host = ""
	}
	value := r.Data
	if r.Type == "CNAME" {
		value = strings.TrimSuffix(value, ".")
	}
	return url.Values{"rrhost": {host}, "rrvalue": {value}, "rrttl": {strconv.Itoa(dnsx.Seconds(r.TTL))}}
}

func (p *Provider) add(ctx context.Context, zone string, r libdns.RR) error {
	params := fields(r)
	params.Set("domain", dnsx.Zone(zone))
	params.Set("rrtype", r.Type)
	_, err := p.call(ctx, "dnsAddRecord", params)
	return err
}

func (p *Provider) remove(ctx context.Context, zone, id string) error {
	_, err := p.call(ctx, "dnsDeleteRecord", url.Values{"domain": {dnsx.Zone(zone)}, "rrid": {id}})
	return err
}

// GetRecords lists every record of the zone (dnsListRecords has no paging).
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

// AppendRecords creates the records (TTL at least MinTTL).
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	in, err := input(records)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var done []libdns.Record
	for _, r := range in {
		if err := p.add(ctx, zone, r); err != nil {
			return done, err
		}
		done = append(done, r)
	}
	return done, nil
}

// SetRecords makes each input RRset exactly the input records: existing
// members are kept (dnsUpdateRecord when the TTL differs), others are
// deleted or created.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	in, err := input(records)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	existing, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	sets := map[string]bool{}
	wanted := map[string]libdns.RR{}
	for _, r := range in {
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
		if want, keep := wanted[key]; keep && !kept[key] {
			kept[key] = true
			if dnsx.Seconds(want.TTL) != dnsx.Seconds(rr.TTL) {
				params := fields(want)
				params.Set("domain", dnsx.Zone(zone))
				params.Set("rrid", old.ID)
				if _, err := p.call(ctx, "dnsUpdateRecord", params); err != nil {
					return nil, err
				}
			}
			continue
		}
		if err := p.remove(ctx, zone, old.ID); err != nil {
			return nil, err
		}
	}
	var out []libdns.Record
	created := map[string]bool{}
	for _, r := range in {
		key := dnsx.Key(r)
		if created[key] {
			continue
		}
		created[key] = true
		out = append(out, r)
		if kept[key] {
			continue
		}
		if err := p.add(ctx, zone, r); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// DeleteRecords removes the matching records (data empty: the whole RRset)
// and returns them.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	existing, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	in := dnsx.RRs(records)
	var deleted []libdns.Record
	for _, old := range existing {
		rr := toRR(old, zone)
		for _, want := range in {
			if dnsx.Matches(rr, want) {
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

// ListZones lists the account's domains (listDomains, 100 per page).
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	const size = 100
	var zones []libdns.Zone
	for page := 1; page <= 1000; page++ {
		res, err := p.call(ctx, "listDomains", url.Values{"page": {strconv.Itoa(page)}, "pageSize": {strconv.Itoa(size)}})
		if err != nil {
			return nil, err
		}
		for _, d := range res.Domains {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(d) + "."})
		}
		if res.Pager == nil || len(res.Domains) < size || (res.Pager.Total > 0 && len(zones) >= int(res.Pager.Total)) {
			return zones, nil
		}
	}
	return nil, fmt.Errorf("%w: NameSilo account exceeds 100000 domains", dnsx.ErrProvider)
}
