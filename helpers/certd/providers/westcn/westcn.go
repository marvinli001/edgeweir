// Package westcn is the West.cn (西部数码) adapter for API v2
// (https://www.west.cn/CustomerCenter/doc/apiv2.html, domain_v2.html):
// form-encoded requests in GBK, authenticated with
// token = md5(username + api_password + millisecond timestamp), valid for
// 10 minutes. The published libdns module reads one page of records,
// deletes and re-adds records in SetRecords and returns unclassified
// errors, so this adapter calls the documented API directly.
//
// The API serves domains in the West.cn account; West.cn may require the
// caller's IP address to be authorized in the API settings (errcode 10002).
package westcn

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/libdns/libdns"
	"golang.org/x/text/encoding/simplifiedchinese"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	endpoint   = "https://api.west.cn/api/v2"
	pageSize   = 1000
	maxRecords = 100000
	minTTL     = 60 // documented TTL range 60-86400
	maxTTL     = 86400
)

// Provider talks to one West.cn account.
type Provider struct {
	BaseURL  string
	Client   *http.Client
	username string
	password string
	now      func() time.Time
	mu       sync.Mutex // serialize read-modify-write sequences
}

// New builds the adapter from the catalog fields (username, api_password).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	username, password := fields["username"], fields["api_password"]
	if !visible(username) || len(username) > 64 || password == "" || len(password) > 256 || !utf8.ValidString(password) || strings.ContainsAny(password, "\r\n\x00") {
		return nil, fmt.Errorf("%w: West.cn username or api_password is malformed", dnsx.ErrInvalid)
	}
	return &Provider{BaseURL: opts.Endpoint(endpoint), Client: opts.Client(), username: username, password: password, now: time.Now}, nil
}

// visible reports whether s is non-empty text without spaces or controls.
func visible(s string) bool {
	if s == "" || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r <= ' ' || r == 0x7f {
			return false
		}
	}
	return true
}

// token is the documented authentication string.
func token(username, password, timestamp string) string {
	sum := md5.Sum([]byte(username + password + timestamp))
	return hex.EncodeToString(sum[:])
}

// num accepts JSON numbers and numeric strings.
type num int

func (n *num) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*n = 0
		return nil
	}
	v, err := strconv.Atoi(s)
	*n = num(v)
	return err
}

type response struct {
	Result  num             `json:"result"`
	Msg     string          `json:"msg"`
	ErrCode num             `json:"errcode"`
	Data    json.RawMessage `json:"data"`
}

// call sends one action. Parameters (and the answer) are GBK; POST sends
// them in the form body, GET in the query string.
func (p *Provider) call(ctx context.Context, method, act string, params url.Values, out any, empty ...int) error {
	ts := strconv.FormatInt(p.now().UnixMilli(), 10)
	params.Set("username", p.username)
	params.Set("time", ts)
	params.Set("token", token(p.username, p.password, ts))
	encoder := simplifiedchinese.GBK.NewEncoder()
	form := url.Values{}
	for k, values := range params {
		for _, v := range values {
			gbk, err := encoder.String(v)
			if err != nil {
				return fmt.Errorf("%w: West.cn %s: value not representable in GBK", dnsx.ErrInvalid, act)
			}
			form.Add(k, gbk)
		}
	}
	query := url.Values{"act": {act}}
	var body *strings.Reader
	if method == http.MethodGet {
		for k, v := range form {
			query[k] = v
		}
		body = strings.NewReader("")
	} else {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, p.BaseURL+"/domain/?"+query.Encode(), body)
	if err != nil {
		return fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	if method != http.MethodGet {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "edgeweir-certd/1 (DNS records)")
	status, raw, err := dnsx.Do(p.Client, req)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return &dnsx.StatusError{Status: status}
	}
	if decoded, err := simplifiedchinese.GBK.NewDecoder().Bytes(raw); err == nil {
		raw = decoded
	}
	var res response
	if json.Unmarshal(bytes.TrimSpace(raw), &res) != nil {
		return fmt.Errorf("%w: invalid West.cn response", dnsx.ErrProvider)
	}
	if res.Result != 200 {
		for _, c := range empty {
			if int(res.ErrCode) == c {
				return nil
			}
		}
		return p.apiError(act, int(res.ErrCode), res.Msg)
	}
	if out != nil && len(res.Data) > 0 && string(res.Data) != "null" && json.Unmarshal(res.Data, out) != nil {
		return fmt.Errorf("%w: invalid West.cn response", dnsx.ErrProvider)
	}
	return nil
}

// apiError maps the documented error codes (domain_v2.html, 6.1).
func (p *Provider) apiError(act string, code int, msg string) error {
	var kind error
	switch code {
	case 10000, 10001:
		kind = dnsx.ErrAuth
	case 10002:
		kind = dnsx.ErrAuth
		msg = "caller IP address is not authorized in the West.cn API settings"
	case 20001, 20109, 20112:
		kind = dnsx.ErrZoneNotFound // not in this account, or DNS not hosted by West.cn
	case 20000, 20102, 20113, 20116, 20119, 20120:
		kind = dnsx.ErrInvalid
	default:
		kind = dnsx.ErrProvider
	}
	msg = strings.ReplaceAll(strings.ReplaceAll(msg, p.password, "***"), p.username, "***")
	return &failure{kind: kind, code: code, text: fmt.Sprintf("%s: West.cn %s errcode %d %s", kind, act, code, dnsx.Short(msg))}
}

type failure struct {
	kind error
	code int
	text string
}

func (f *failure) Error() string { return f.text }
func (f *failure) Unwrap() error { return f.kind }

func code(err error) int {
	var f *failure
	if errors.As(err, &f) {
		return f.code
	}
	return 0
}

type record struct {
	ID    num    `json:"id"`
	Item  string `json:"item"`
	Value string `json:"value"`
	Type  string `json:"type"`
	TTL   num    `json:"ttl"`
	Line  string `json:"line"`
}

func (r record) rr(zone string) libdns.RR {
	data := r.Value
	if strings.EqualFold(r.Type, "TXT") {
		data = dnsx.Unquote(data)
	}
	return dnsx.RR(dnsx.Name(r.Item, zone), r.Type, data, int(r.TTL))
}

func (r record) main() bool { return r.Line == "" }

type page struct {
	Items      []record `json:"items"`
	Total      num      `json:"total"`
	TotalPages num      `json:"totalpages"`
}

// 30001 / 30201: the query has no results.
var noData = []int{30001, 30201}

func (p *Provider) list(ctx context.Context, zone string) ([]record, error) {
	var all []record
	for pageNo := 1; ; pageNo++ {
		var res page
		if err := p.call(ctx, http.MethodPost, "getdnsrecord", url.Values{
			"domain": {dnsx.Zone(zone)}, "limit": {strconv.Itoa(pageSize)}, "pageno": {strconv.Itoa(pageNo)},
		}, &res, noData...); err != nil {
			return nil, err
		}
		all = append(all, res.Items...)
		if len(all) > maxRecords {
			return nil, fmt.Errorf("%w: West.cn zone exceeds %d records", dnsx.ErrProvider, maxRecords)
		}
		if last(pageNo, len(res.Items), len(all), int(res.TotalPages), int(res.Total)) {
			return all, nil
		}
	}
}

// last reports whether a page ends the listing. The totals decide when the
// answer has them: the page size limit is not documented, and the server may
// return fewer items than asked for.
func last(pageNo, items, seen, totalPages, total int) bool {
	switch {
	case items == 0:
		return true
	case totalPages > 0:
		return pageNo >= totalPages
	case total > 0:
		return seen >= total
	default:
		return items < pageSize
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
		out = append(out, r.rr(zone))
	}
	return out, nil
}

// ttl clamps a TTL to the documented range.
func ttl(r libdns.RR) int {
	return min(max(dnsx.Seconds(r.TTL), minTTL), maxTTL)
}

func value(r libdns.RR) string {
	if strings.EqualFold(r.Type, "CNAME") {
		return strings.TrimSuffix(r.Data, ".")
	}
	return r.Data
}

func (p *Provider) create(ctx context.Context, zone string, r libdns.RR) (libdns.RR, error) {
	err := p.call(ctx, http.MethodPost, "adddnsrecord", url.Values{
		"domain": {dnsx.Zone(zone)}, "host": {r.Name}, "type": {strings.ToUpper(r.Type)}, "value": {value(r)},
		"ttl": {strconv.Itoa(ttl(r))}, "level": {"10"},
	}, nil)
	if code(err) == 20118 {
		err = nil // an identical record exists
	}
	r.TTL = time.Duration(ttl(r)) * time.Second
	return r, err
}

func (p *Provider) update(ctx context.Context, zone, id string, r libdns.RR) (libdns.RR, error) {
	err := p.call(ctx, http.MethodPost, "moddnsrecord", url.Values{
		"domain": {dnsx.Zone(zone)}, "id": {id}, "value": {value(r)}, "ttl": {strconv.Itoa(ttl(r))},
	}, nil)
	r.TTL = time.Duration(ttl(r)) * time.Second
	return r, err
}

func (p *Provider) remove(ctx context.Context, zone, id string) error {
	err := p.call(ctx, http.MethodPost, "deldnsrecord", url.Values{"domain": {dnsx.Zone(zone)}, "id": {id}}, nil)
	if code(err) == 20120 {
		return nil // already gone
	}
	return err
}

// AppendRecords creates the records on the default line; an identical
// existing record counts as created.
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
// Members on other lines are deleted first (West.cn requires a default-line
// record while other lines exist).
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	existing, err := p.list(ctx, zone)
	if err != nil {
		return nil, err
	}
	members := make([]member, 0, len(existing))
	for _, r := range existing {
		members = append(members, member{id: strconv.Itoa(int(r.ID)), rr: r.rr(zone), main: r.main()})
	}
	input := dnsx.RRs(records)
	for i := range input {
		input[i].TTL = time.Duration(ttl(input[i])) * time.Second // compare with what can be stored
	}
	pl := plan(members, input)
	stored := map[string]libdns.RR{}
	for _, k := range pl.kept {
		stored[dnsx.Key(k.want)] = k.have
	}
	for _, u := range pl.updates {
		r, err := p.update(ctx, zone, u.id, u.rr)
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
		if err := p.remove(ctx, zone, d.id); err != nil {
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
	// Other lines first: West.cn keeps a default-line record while other lines exist.
	for _, mainLine := range []bool{false, true} {
		for _, old := range existing {
			if old.main() != mainLine {
				continue
			}
			rr := old.rr(zone)
			for _, in := range input {
				if dnsx.Matches(rr, in) {
					if err := p.remove(ctx, zone, strconv.Itoa(int(old.ID))); err != nil {
						return deleted, err
					}
					deleted = append(deleted, rr)
					break
				}
			}
		}
	}
	return deleted, nil
}

// ListZones lists the domains of the account (getdomains).
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	var zones []libdns.Zone
	for pageNo := 1; len(zones) < maxRecords; pageNo++ {
		var res struct {
			Items []struct {
				Domain string `json:"domain"`
			} `json:"items"`
			TotalPages num `json:"totalpages"`
		}
		if err := p.call(ctx, http.MethodGet, "getdomains", url.Values{
			"limit": {strconv.Itoa(pageSize)}, "page": {strconv.Itoa(pageNo)},
		}, &res, noData...); err != nil {
			return nil, err
		}
		for _, d := range res.Items {
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(d.Domain) + "."})
		}
		if last(pageNo, len(res.Items), len(zones), int(res.TotalPages), 0) {
			break
		}
	}
	return zones, nil
}
