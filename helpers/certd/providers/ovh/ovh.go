// Package ovh is the OVHcloud adapter for the v1 API
// (https://eu.api.ovh.com/console/?section=%2Fdomain): application key,
// application secret and consumer key; every call is signed with
// "$1$" + SHA1(AS+CK+METHOD+URL+BODY+TIMESTAMP) against the server clock read
// from /auth/time, and the zone is refreshed after writes. The libdns module
// (v1.1.0) is not used: it hides go-ovh's HTTP client (180 s timeout,
// redirects followed), go-ovh reads OVH_* variables and ovh.conf files, its
// SetRecords never rewrites the TTL of kept members, and it has no ListZones.
package ovh

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
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
	userAgent  = "edgeweir-certd/1"
	maxRecords = 100000
	minTTL     = 60
)

// endpoints are the API regions (names as in go-ovh and python-ovh).
var endpoints = map[string]string{
	"ovh-eu": "https://eu.api.ovh.com/1.0",
	"ovh-ca": "https://ca.api.ovh.com/1.0",
	"ovh-us": "https://api.us.ovhcloud.com/1.0",
}

var keyPattern = regexp.MustCompile(`^[A-Za-z0-9]{8,128}$`)

// Provider talks to one OVHcloud account.
type Provider struct {
	appKey, appSecret, consumerKey string
	base                           string
	client                         *http.Client
	now                            func() time.Time
	mu                             sync.Mutex // writes and refreshes run one at a time
	clockMu                        sync.Mutex
	delta                          time.Duration // server clock minus local clock
	synced                         bool
}

// New builds the adapter from the catalog fields (endpoint, application_key,
// application_secret, consumer_key).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	name := fields["endpoint"]
	if name == "" {
		name = "ovh-eu"
	}
	fixed, ok := endpoints[name]
	if !ok {
		return nil, fmt.Errorf("%w: OVH endpoint must be ovh-eu, ovh-ca or ovh-us", dnsx.ErrInvalid)
	}
	for _, key := range []string{"application_key", "application_secret", "consumer_key"} {
		if !keyPattern.MatchString(fields[key]) {
			return nil, fmt.Errorf("%w: OVH %s is malformed", dnsx.ErrInvalid, key)
		}
	}
	return &Provider{
		appKey: fields["application_key"], appSecret: fields["application_secret"], consumerKey: fields["consumer_key"],
		base: opts.Endpoint(fixed), client: opts.Client(), now: time.Now,
	}, nil
}

// sign computes X-Ovh-Signature over the full request URL.
func sign(secret, consumer, method, target string, body []byte, timestamp int64) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s+%s+%s+%s+%s+%d", secret, consumer, method, target, body, timestamp)
	return "$1$" + hex.EncodeToString(h.Sum(nil))
}

type apiErr struct {
	Class     string `json:"class"`
	ErrorCode string `json:"errorCode"`
	Message   string `json:"message"`
}

// authCodes are errorCode values of rejected credentials or signatures and
// of calls outside the consumer key's access rules.
var authCodes = map[string]bool{"INVALID_SIGNATURE": true, "INVALID_CREDENTIAL": true, "INVALID_KEY": true, "NOT_CREDENTIAL": true, "NOT_GRANTED_CALL": true}

func apiError(status int, raw []byte) error {
	var e apiErr
	_ = json.Unmarshal(raw, &e)
	kind := (&dnsx.StatusError{Status: status}).Kind()
	if authCodes[e.ErrorCode] || strings.HasPrefix(e.Class, "Client::Forbidden") || strings.HasPrefix(e.Class, "Client::Unauthorized") {
		kind = dnsx.ErrAuth
	}
	code := e.ErrorCode
	if code == "" {
		code = e.Class
	}
	return fmt.Errorf("%w: OVH HTTP %d %s", kind, status, dnsx.Short(strings.TrimSpace(code+" "+e.Message)))
}

func (p *Provider) send(ctx context.Context, method, target string, body []byte, header http.Header) ([]byte, error) {
	var reader io.Reader
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	req.Header = header
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json;charset=utf-8")
	}
	status, raw, err := dnsx.Do(p.client, req)
	if err != nil {
		return nil, err
	}
	if status < 200 || status > 299 {
		return nil, apiError(status, raw)
	}
	return raw, nil
}

// timestamp is the server's current time; /auth/time is read once.
func (p *Provider) timestamp(ctx context.Context) (int64, error) {
	p.clockMu.Lock()
	defer p.clockMu.Unlock()
	if !p.synced {
		raw, err := p.send(ctx, http.MethodGet, p.base+"/auth/time", nil, http.Header{})
		if err != nil {
			return 0, err
		}
		server, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
		if err != nil {
			return 0, fmt.Errorf("%w: invalid OVH /auth/time response", dnsx.ErrProvider)
		}
		p.delta = time.Unix(server, 0).Sub(p.now())
		p.synced = true
	}
	return p.now().Add(p.delta).Unix(), nil
}

func (p *Provider) call(ctx context.Context, method, path string, in, out any) error {
	var body []byte
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return fmt.Errorf("%w: encoding request", dnsx.ErrInvalid)
		}
		body = raw
	}
	timestamp, err := p.timestamp(ctx)
	if err != nil {
		return err
	}
	target := p.base + path
	header := http.Header{}
	header.Set("X-Ovh-Application", p.appKey)
	header.Set("X-Ovh-Consumer", p.consumerKey)
	header.Set("X-Ovh-Timestamp", strconv.FormatInt(timestamp, 10))
	header.Set("X-Ovh-Signature", sign(p.appSecret, p.consumerKey, method, target, body, timestamp))
	raw, err := p.send(ctx, method, target, body, header)
	if err != nil {
		return err
	}
	if out == nil || len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return nil
	}
	if json.Unmarshal(raw, out) != nil {
		return fmt.Errorf("%w: invalid OVH response", dnsx.ErrProvider)
	}
	return nil
}

type record struct {
	ID        int64  `json:"id"`
	FieldType string `json:"fieldType"`
	SubDomain string `json:"subDomain"`
	Target    string `json:"target"`
	TTL       int    `json:"ttl"`
}

type createBody struct {
	FieldType string `json:"fieldType"`
	SubDomain string `json:"subDomain"`
	Target    string `json:"target"`
	TTL       int    `json:"ttl"`
}

type ttlBody struct {
	TTL int `json:"ttl"`
}

func zonePath(zone string) string { return "/domain/zone/" + url.PathEscape(dnsx.Zone(zone)) }

// subDomain is OVH's name form: empty for the apex.
func subDomain(name string) string {
	if name == "@" {
		return ""
	}
	return strings.ToLower(name)
}

func toRR(r record) libdns.RR {
	name := strings.ToLower(r.SubDomain)
	if name == "" {
		name = "@"
	}
	data := r.Target
	if r.FieldType == "TXT" {
		data = dnsx.Unquote(data)
	}
	return dnsx.RR(name, r.FieldType, data, r.TTL)
}

func ttl(r libdns.RR) int { return max(dnsx.Seconds(r.TTL), minTTL) }

// target is OVH's data form: a CNAME target without a trailing dot is
// relative to the zone, so absolute names get one.
func target(r libdns.RR) string {
	if strings.EqualFold(r.Type, "CNAME") && !strings.HasSuffix(r.Data, ".") {
		return r.Data + "."
	}
	return r.Data
}

func check(records []libdns.RR) error {
	for _, r := range records {
		if strings.EqualFold(r.Type, "CNAME") && subDomain(r.Name) == "" {
			return fmt.Errorf("%w: OVH does not allow a CNAME at the zone apex", dnsx.ErrUnsupported)
		}
	}
	return nil
}

func (p *Provider) ids(ctx context.Context, zone string, filter url.Values) ([]int64, error) {
	path := zonePath(zone) + "/record"
	if len(filter) > 0 {
		path += "?" + filter.Encode()
	}
	var ids []int64
	if err := p.call(ctx, http.MethodGet, path, nil, &ids); err != nil {
		return nil, err
	}
	if len(ids) > maxRecords {
		return nil, fmt.Errorf("%w: OVH zone exceeds %d records", dnsx.ErrProvider, maxRecords)
	}
	return ids, nil
}

func (p *Provider) get(ctx context.Context, zone string, id int64) (record, error) {
	var r record
	err := p.call(ctx, http.MethodGet, zonePath(zone)+"/record/"+strconv.FormatInt(id, 10), nil, &r)
	return r, err
}

// rrset returns the members of one (name, type) pair. The subDomain filter
// is a case-insensitive LIKE ("_" matches any character), so names are
// compared again.
func (p *Provider) rrset(ctx context.Context, zone, name, typ string) ([]record, error) {
	sub := subDomain(name)
	ids, err := p.ids(ctx, zone, url.Values{"fieldType": {strings.ToUpper(typ)}, "subDomain": {sub}})
	if err != nil {
		return nil, err
	}
	var out []record
	for _, id := range ids {
		r, err := p.get(ctx, zone, id)
		if err != nil {
			return nil, err
		}
		if strings.EqualFold(r.SubDomain, sub) && strings.EqualFold(r.FieldType, typ) {
			out = append(out, r)
		}
	}
	return out, nil
}

func (p *Provider) create(ctx context.Context, zone string, r libdns.RR) (record, error) {
	var created record
	err := p.call(ctx, http.MethodPost, zonePath(zone)+"/record", createBody{FieldType: strings.ToUpper(r.Type), SubDomain: subDomain(r.Name), Target: target(r), TTL: ttl(r)}, &created)
	return created, err
}

func (p *Provider) remove(ctx context.Context, zone string, id int64) error {
	return p.call(ctx, http.MethodDelete, zonePath(zone)+"/record/"+strconv.FormatInt(id, 10), nil, nil)
}

// refresh publishes the zone's pending changes.
func (p *Provider) refresh(ctx context.Context, zone string) error {
	return p.call(ctx, http.MethodPost, zonePath(zone)+"/refresh", nil, nil)
}

// sets groups records by (name, type) in input order.
func sets(records []libdns.RR) [][]libdns.RR {
	index := map[string]int{}
	var out [][]libdns.RR
	for _, r := range records {
		key := dnsx.SetKey(r)
		i, ok := index[key]
		if !ok {
			i = len(out)
			index[key] = i
			out = append(out, nil)
		}
		out[i] = append(out[i], r)
	}
	return out
}

// GetRecords lists every record of the zone (one request per record: the
// API lists record IDs only).
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	ids, err := p.ids(ctx, zone, nil)
	if err != nil {
		return nil, err
	}
	out := make([]libdns.Record, 0, len(ids))
	for _, id := range ids {
		r, err := p.get(ctx, zone, id)
		if err != nil {
			return nil, err
		}
		out = append(out, toRR(r))
	}
	return out, nil
}

// AppendRecords creates the records and refreshes the zone.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	input := dnsx.RRs(records)
	if err := check(input); err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var done []libdns.Record
	for _, r := range input {
		created, err := p.create(ctx, zone, r)
		if err != nil {
			return done, err
		}
		done = append(done, toRR(created))
	}
	if len(done) > 0 {
		if err := p.refresh(ctx, zone); err != nil {
			return done, err
		}
	}
	return done, nil
}

// SetRecords makes each input RRset exactly the input records: members that
// already exist are kept (TTL rewritten when it differs), others are
// removed or created; the zone is refreshed once.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	input := dnsx.RRs(records)
	if err := check(input); err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	changed := false
	for _, set := range sets(input) {
		existing, err := p.rrset(ctx, zone, set[0].Name, set[0].Type)
		if err != nil {
			return nil, err
		}
		wanted := map[string]libdns.RR{}
		for _, r := range set {
			if _, dup := wanted[dnsx.Key(r)]; !dup {
				wanted[dnsx.Key(r)] = r
			}
		}
		kept := map[string]bool{}
		for _, old := range existing {
			key := dnsx.Key(toRR(old))
			if want, ok := wanted[key]; ok && !kept[key] {
				kept[key] = true
				if old.TTL != ttl(want) {
					if err := p.call(ctx, http.MethodPut, zonePath(zone)+"/record/"+strconv.FormatInt(old.ID, 10), ttlBody{TTL: ttl(want)}, nil); err != nil {
						return nil, err
					}
					changed = true
				}
				continue
			}
			if err := p.remove(ctx, zone, old.ID); err != nil {
				return nil, err
			}
			changed = true
		}
		for _, r := range set {
			if kept[dnsx.Key(r)] {
				continue
			}
			kept[dnsx.Key(r)] = true
			if _, err := p.create(ctx, zone, r); err != nil {
				return nil, err
			}
			changed = true
		}
	}
	if changed {
		if err := p.refresh(ctx, zone); err != nil {
			return nil, err
		}
	}
	return records, nil
}

// DeleteRecords removes the matching records (data empty: the whole RRset)
// and refreshes the zone.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var deleted []libdns.Record
	for _, set := range sets(dnsx.RRs(records)) {
		existing, err := p.rrset(ctx, zone, set[0].Name, set[0].Type)
		if err != nil {
			return deleted, err
		}
		for _, old := range existing {
			rr := toRR(old)
			for _, in := range set {
				if dnsx.Matches(rr, in) {
					if err := p.remove(ctx, zone, old.ID); err != nil {
						return deleted, err
					}
					deleted = append(deleted, rr)
					break
				}
			}
		}
	}
	if len(deleted) > 0 {
		if err := p.refresh(ctx, zone); err != nil {
			return deleted, err
		}
	}
	return deleted, nil
}

// ListZones lists the account's DNS zones.
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var names []string
	if err := p.call(ctx, http.MethodGet, "/domain/zone", nil, &names); err != nil {
		return nil, err
	}
	zones := make([]libdns.Zone, 0, len(names))
	for _, name := range names {
		zones = append(zones, libdns.Zone{Name: dnsx.Zone(name) + "."})
	}
	return zones, nil
}
