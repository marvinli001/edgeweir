// Package tencentcloud is the Tencent Cloud DNSPod adapter (API 3.0,
// version 2021-03-23, TC3-HMAC-SHA256 signatures,
// https://cloud.tencent.com/document/api/1427/56189). The published libdns
// module never reads Response.Error (failed calls look successful), reads
// one page of 100 records and signs a fixed host, so the international
// endpoint cannot work; this adapter calls the documented API directly.
//
// China-site accounts use dnspod.tencentcloudapi.com, international
// (tencentcloud.com) accounts dnspod.intl.tencentcloudapi.com, chosen by the
// site field. The default line is "默认" on the China site and "Default" on
// the international site; requests also send its line ID "0".
package tencentcloud

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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

const (
	service     = "dnspod"
	apiVersion  = "2021-03-23"
	contentType = "application/json; charset=utf-8"
	pageSize    = 3000 // DescribeRecordList / DescribeDomainList maximum
	maxRecords  = 100000
	// minTTL is the smallest TTL of the free plan; writes rejected for their
	// TTL are retried with it.
	minTTL = 600
)

var (
	hosts        = map[string]string{"cn": "dnspod.tencentcloudapi.com", "intl": "dnspod.intl.tencentcloudapi.com"}
	defaultLines = map[string]string{"cn": "默认", "intl": "Default"}
	idPattern    = regexp.MustCompile(`^[A-Za-z0-9]{1,128}$`)
)

// Provider talks to one Tencent Cloud account.
type Provider struct {
	BaseURL   string
	Client    *http.Client
	secretID  string
	secretKey string
	line      string
	now       func() time.Time
	mu        sync.Mutex // serialize read-modify-write sequences
}

// New builds the adapter from the catalog fields (secret_id, secret_key,
// site "cn" or "intl").
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	id, key, site := fields["secret_id"], fields["secret_key"], fields["site"]
	if site == "" {
		site = "cn"
	}
	host, ok := hosts[site]
	if !ok {
		return nil, fmt.Errorf("%w: Tencent Cloud site must be cn or intl", dnsx.ErrInvalid)
	}
	if !idPattern.MatchString(id) || !printable(key) {
		return nil, fmt.Errorf("%w: Tencent Cloud secret_id or secret_key is malformed", dnsx.ErrInvalid)
	}
	return &Provider{
		BaseURL: opts.Endpoint("https://" + host), Client: opts.Client(),
		secretID: id, secretKey: key, line: defaultLines[site], now: time.Now,
	}, nil
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

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

// authorization computes the TC3-HMAC-SHA256 Authorization header of a
// POST / request signing content-type, host and x-tc-action.
func authorization(secretID, secretKey, svc, host, action string, timestamp int64, payload []byte) string {
	date := time.Unix(timestamp, 0).UTC().Format("2006-01-02")
	canonical := "POST\n/\n\ncontent-type:" + contentType + "\nhost:" + host + "\nx-tc-action:" + strings.ToLower(action) +
		"\n\ncontent-type;host;x-tc-action\n" + sha256Hex(payload)
	scope := date + "/" + svc + "/tc3_request"
	toSign := "TC3-HMAC-SHA256\n" + strconv.FormatInt(timestamp, 10) + "\n" + scope + "\n" + sha256Hex([]byte(canonical))
	key := hmacSHA256(hmacSHA256(hmacSHA256([]byte("TC3"+secretKey), date), svc), "tc3_request")
	return "TC3-HMAC-SHA256 Credential=" + secretID + "/" + scope + ", SignedHeaders=content-type;host;x-tc-action, Signature=" +
		hex.EncodeToString(hmacSHA256(key, toSign))
}

// failure is a classified API error that keeps the provider code.
type failure struct {
	kind error
	code string
	text string
}

func (f *failure) Error() string { return f.text }
func (f *failure) Unwrap() error { return f.kind }

func code(err error) string {
	var f *failure
	if errors.As(err, &f) {
		return f.code
	}
	return ""
}

func (p *Provider) call(ctx context.Context, action string, in, out any) error {
	payload, err := json.Marshal(in)
	if err != nil {
		return fmt.Errorf("%w: encoding request", dnsx.ErrInvalid)
	}
	target, err := url.Parse(p.BaseURL + "/")
	if err != nil {
		return fmt.Errorf("%w: invalid endpoint", dnsx.ErrInvalid)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	ts := p.now().Unix()
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-TC-Action", action)
	req.Header.Set("X-TC-Version", apiVersion)
	req.Header.Set("X-TC-Timestamp", strconv.FormatInt(ts, 10))
	req.Header.Set("X-TC-Language", "en-US")
	req.Header.Set("Authorization", authorization(p.secretID, p.secretKey, service, target.Host, action, ts, payload))
	req.Header.Set("User-Agent", "edgeweir-certd/1 (DNS records)")
	status, body, err := dnsx.Do(p.Client, req)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return &dnsx.StatusError{Status: status}
	}
	var envelope struct {
		Response json.RawMessage `json:"Response"`
	}
	var failed struct {
		Error *struct {
			Code    string `json:"Code"`
			Message string `json:"Message"`
		} `json:"Error"`
	}
	if json.Unmarshal(body, &envelope) != nil || json.Unmarshal(envelope.Response, &failed) != nil {
		return fmt.Errorf("%w: invalid DNSPod response", dnsx.ErrProvider)
	}
	if failed.Error != nil {
		return p.apiError(action, failed.Error.Code, failed.Error.Message)
	}
	if out != nil && json.Unmarshal(envelope.Response, out) != nil {
		return fmt.Errorf("%w: invalid DNSPod response", dnsx.ErrProvider)
	}
	return nil
}

// apiError maps the common and DNSPod error codes
// (https://cloud.tencent.com/document/api/1427/56192).
func (p *Provider) apiError(action, c, message string) error {
	var kind error
	switch {
	case strings.HasPrefix(c, "AuthFailure"), c == "UnauthorizedOperation", strings.HasPrefix(c, "OperationDenied"),
		c == "InvalidParameter.RequestIpLimited", c == "FailedOperation.LoginFailed", c == "FailedOperation.AccountIsLocked",
		c == "FailedOperation.LoginAreaNotAllowed", c == "InvalidParameter.AccountIsBanned":
		kind = dnsx.ErrAuth
	case c == "FailedOperation.NotDomainOwner", c == "InvalidParameterValue.DomainNotExists", c == "InvalidParameter.DomainInvalid",
		c == "ResourceNotFound.NoDataOfDomain":
		kind = dnsx.ErrZoneNotFound
	case strings.HasPrefix(c, "RequestLimitExceeded"), c == "FailedOperation.FrequencyLimit":
		kind = dnsx.ErrRateLimited
	case strings.HasPrefix(c, "InvalidParameter"), strings.HasPrefix(c, "MissingParameter"), strings.HasPrefix(c, "UnknownParameter"),
		c == "LimitExceeded.RecordTtlLimit":
		kind = dnsx.ErrInvalid
	case strings.HasPrefix(c, "InternalError"), c == "FailedOperation.UnknowError":
		kind = dnsx.ErrUnreachable
	default:
		kind = dnsx.ErrProvider
	}
	message = strings.ReplaceAll(strings.ReplaceAll(message, p.secretKey, "***"), p.secretID, "***")
	return &failure{kind: kind, code: c, text: fmt.Sprintf("%s: DNSPod %s %s %s", kind, action, c, dnsx.Short(message))}
}

type record struct {
	RecordID uint64 `json:"RecordId"`
	Name     string `json:"Name"`
	Type     string `json:"Type"`
	Value    string `json:"Value"`
	TTL      int    `json:"TTL"`
	Line     string `json:"Line"`
	LineID   string `json:"LineId"`
}

func (r record) rr() libdns.RR {
	name := strings.ToLower(r.Name)
	if name == "" {
		name = "@"
	}
	data := r.Value
	if strings.EqualFold(r.Type, "TXT") {
		data = dnsx.Unquote(data)
	}
	return dnsx.RR(name, r.Type, data, r.TTL)
}

func (r record) main() bool {
	return r.LineID == "0" || (r.LineID == "" && (r.Line == "默认" || r.Line == "Default"))
}

func (p *Provider) list(ctx context.Context, zone string) ([]record, error) {
	var all []record
	for offset := 0; ; offset += pageSize {
		var res struct {
			RecordCountInfo struct {
				TotalCount int `json:"TotalCount"`
			} `json:"RecordCountInfo"`
			RecordList []record `json:"RecordList"`
		}
		err := p.call(ctx, "DescribeRecordList", map[string]any{"Domain": dnsx.Zone(zone), "Offset": offset, "Limit": pageSize}, &res)
		if code(err) == "ResourceNotFound.NoDataOfRecord" {
			return all, nil
		}
		if err != nil {
			return nil, err
		}
		all = append(all, res.RecordList...)
		if len(all) > maxRecords {
			return nil, fmt.Errorf("%w: DNSPod zone exceeds %d records", dnsx.ErrProvider, maxRecords)
		}
		if len(res.RecordList) < pageSize || len(all) >= res.RecordCountInfo.TotalCount {
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

// write runs CreateRecord or ModifyRecord on the default line; a TTL below
// the plan's minimum is retried with 600 s. It returns the record as stored.
func (p *Provider) write(ctx context.Context, action, zone string, id uint64, r libdns.RR) (libdns.RR, error) {
	in := map[string]any{
		"Domain": dnsx.Zone(zone), "SubDomain": r.Name, "RecordType": strings.ToUpper(r.Type),
		"RecordLine": p.line, "RecordLineId": "0", "Value": r.Data, "TTL": dnsx.Seconds(r.TTL),
	}
	if id != 0 {
		in["RecordId"] = id
	}
	err := p.call(ctx, action, in, nil)
	if code(err) == "LimitExceeded.RecordTtlLimit" && dnsx.Seconds(r.TTL) < minTTL {
		r.TTL = minTTL * time.Second
		in["TTL"] = minTTL
		err = p.call(ctx, action, in, nil)
	}
	if action == "CreateRecord" && code(err) == "InvalidParameter.DomainRecordExist" {
		err = nil // an identical record exists
	}
	return r, err
}

func (p *Provider) remove(ctx context.Context, zone string, id uint64) error {
	err := p.call(ctx, "DeleteRecord", map[string]any{"Domain": dnsx.Zone(zone), "RecordId": id}, nil)
	if code(err) == "InvalidParameter.RecordIdInvalid" {
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
		stored, err := p.write(ctx, "CreateRecord", zone, 0, r)
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
	ids := map[string]uint64{}
	members := make([]member, 0, len(existing))
	for _, r := range existing {
		id := strconv.FormatUint(r.RecordID, 10)
		ids[id] = r.RecordID
		members = append(members, member{id: id, rr: r.rr(), main: r.main()})
	}
	pl := plan(members, dnsx.RRs(records))
	stored := map[string]libdns.RR{}
	for _, k := range pl.kept {
		stored[dnsx.Key(k.want)] = k.have
	}
	for _, u := range pl.updates {
		r, err := p.write(ctx, "ModifyRecord", zone, ids[u.id], u.rr)
		if err != nil {
			return nil, err
		}
		stored[dnsx.Key(u.rr)] = r
	}
	for _, c := range pl.creates {
		r, err := p.write(ctx, "CreateRecord", zone, 0, c)
		if err != nil {
			return nil, err
		}
		stored[dnsx.Key(c)] = r
	}
	for _, d := range pl.deletes {
		if err := p.remove(ctx, zone, ids[d.id]); err != nil {
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
				if err := p.remove(ctx, zone, old.RecordID); err != nil {
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
	for offset := 0; offset < maxRecords; offset += pageSize {
		var res struct {
			DomainCountInfo struct {
				AllTotal int `json:"AllTotal"`
			} `json:"DomainCountInfo"`
			DomainList []struct {
				Name     string `json:"Name"`
				Punycode string `json:"Punycode"`
			} `json:"DomainList"`
		}
		err := p.call(ctx, "DescribeDomainList", map[string]any{"Type": "ALL", "Offset": offset, "Limit": pageSize}, &res)
		if code(err) == "ResourceNotFound.NoDataOfDomain" {
			break
		}
		if err != nil {
			return nil, err
		}
		for _, d := range res.DomainList {
			name := d.Punycode
			if name == "" {
				name = d.Name
			}
			zones = append(zones, libdns.Zone{Name: dnsx.Zone(name) + "."})
		}
		if len(res.DomainList) < pageSize || len(zones) >= res.DomainCountInfo.AllTotal {
			break
		}
	}
	return zones, nil
}
