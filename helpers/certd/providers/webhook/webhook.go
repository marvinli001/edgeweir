// Package webhook hands DNS record operations to an HTTP endpoint the user
// runs (for DNS services without a built-in adapter). The endpoint is the
// user's own, so every connection goes through the outbound address policy
// (dnsx.Options.PolicyClient): special-purpose addresses only when the
// operator allows them, cleartext HTTP only to such allowed addresses, no
// redirects.
//
// # Protocol v1
//
// Every operation is one request:
//
//	POST <url>
//	Content-Type: application/json
//	User-Agent: edgeweir-certd/1
//	X-Edgeweir-Timestamp: <unix seconds>
//	X-Edgeweir-Signature: v1=<hex>
//
// <hex> is the lowercase hex HMAC-SHA256, keyed with the shared secret, of
// the timestamp header value, ".", and the raw request body. Receivers
// recompute it over the raw body bytes, compare in constant time, and reject
// (401) a bad signature or a timestamp more than 300 s away from their clock.
// Example: secret "example-secret-0123456789", timestamp 1700000000, body
// {"action":"zones"} give
// v1=3af007dacbb4d9b54c57bc499f275d13e48a5513e8ecf036d83c1b5a6c0f20f8.
//
// Body:
//
//	{"action":"set","zone":"example.com","records":[{"name":"www","type":"A","data":"192.0.2.1","ttl":600}]}
//
// zone is the zone name without the trailing dot (absent for zones).
// records is absent for list and zones. A record has name (relative to the
// zone, "@" for the apex), type (upper case), data (A/AAAA address, CNAME
// host name with an optional trailing dot, TXT the raw text without quotes)
// and ttl (seconds). Actions:
//
//	list    return every record of the zone
//	append  add the records; existing records stay
//	set     for each (name, type) in records, the zone afterwards holds
//	        exactly the given records for that pair (the RRset is replaced);
//	        other RRsets stay
//	delete  remove the records matching name, type and data; empty data
//	        removes the whole (name, type) RRset; ttl is ignored
//	zones   list the zones the receiver manages
//
// A 2xx answer is JSON (at most 16 MiB): {"records":[...]} for list (every
// record) and for append, set and delete (the records added, set or
// deleted); {"zones":["example.com"]} for zones. Other answers: 401 or 403
// authentication failed, 404 unknown zone, 501 for zones when the receiver
// cannot list zones; any other status is an error (429 is reported as rate
// limiting, 5xx as the receiver being unavailable). Error answers may carry
// {"error":"short text"}, shown to the user.
package webhook

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/libdns/libdns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const maxRecords = 100000

// Provider calls one webhook receiver.
type Provider struct {
	url    string
	secret []byte
	client *http.Client
	now    func() time.Time
}

// New builds the adapter from the catalog fields (url, secret).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	u, err := url.Parse(strings.TrimSpace(fields["url"]))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.Opaque != "" ||
		u.Fragment != "" || strings.Contains(fields["url"], "#") {
		return nil, fmt.Errorf("%w: webhook url must be http(s)://host[:port]/path without credentials or fragment", dnsx.ErrInvalid)
	}
	if port := u.Port(); port != "" {
		if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
			return nil, fmt.Errorf("%w: webhook url has an invalid port", dnsx.ErrInvalid)
		}
	}
	secret := fields["secret"]
	if utf8.RuneCountInString(secret) < 16 {
		return nil, fmt.Errorf("%w: webhook secret must have at least 16 characters", dnsx.ErrInvalid)
	}
	return &Provider{url: u.String(), secret: []byte(secret), client: opts.PolicyClient(), now: time.Now}, nil
}

type record struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Data string `json:"data"`
	TTL  int    `json:"ttl"`
}

type request struct {
	Action  string   `json:"action"`
	Zone    string   `json:"zone,omitempty"`
	Records []record `json:"records,omitempty"`
}

type response struct {
	Records []record `json:"records"`
	Zones   []string `json:"zones"`
}

// sign returns the X-Edgeweir-Signature value.
func sign(secret []byte, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	return "v1=" + hex.EncodeToString(mac.Sum(nil))
}

func describe(body []byte) string {
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil {
		return e.Error
	}
	return ""
}

func (p *Provider) call(ctx context.Context, in request) (*response, error) {
	body, err := json.Marshal(in)
	if err != nil {
		return nil, fmt.Errorf("%w: encoding request", dnsx.ErrInvalid)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("%w: building request", dnsx.ErrInvalid)
	}
	timestamp := strconv.FormatInt(p.now().Unix(), 10)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "edgeweir-certd/1")
	req.Header.Set("X-Edgeweir-Timestamp", timestamp)
	req.Header.Set("X-Edgeweir-Signature", sign(p.secret, timestamp, body))
	status, raw, err := dnsx.Do(p.client, req)
	if err != nil {
		return nil, err
	}
	if status < 200 || status > 299 {
		message := dnsx.Short(describe(raw))
		if in.Action == "zones" && status == http.StatusNotImplemented {
			return nil, fmt.Errorf("%w: the webhook receiver cannot list zones", dnsx.ErrUnsupported)
		}
		return nil, &dnsx.StatusError{Status: status, Message: message}
	}
	var out response
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("%w: invalid JSON response", dnsx.ErrProvider)
	}
	if len(out.Records) > maxRecords {
		return nil, fmt.Errorf("%w: webhook answer exceeds %d records", dnsx.ErrProvider, maxRecords)
	}
	return &out, nil
}

// wire converts input records; absolute names must be inside the zone.
func wire(zone string, input []libdns.Record, deleting bool) ([]record, error) {
	z := dnsx.Zone(zone)
	out := make([]record, 0, len(input))
	for _, r := range dnsx.RRs(input) {
		if n := strings.TrimSuffix(strings.ToLower(r.Name), "."); strings.HasSuffix(r.Name, ".") && n != z && !strings.HasSuffix(n, "."+z) {
			return nil, fmt.Errorf("%w: record name %q is outside the zone", dnsx.ErrInvalid, dnsx.Short(r.Name))
		}
		ttl := dnsx.Seconds(r.TTL)
		if deleting {
			ttl = int(r.TTL / time.Second)
		}
		out = append(out, record{Name: dnsx.Name(r.Name, zone), Type: strings.ToUpper(r.Type), Data: r.Data, TTL: ttl})
	}
	return out, nil
}

func toLibdns(zone string, in []record) []libdns.Record {
	out := make([]libdns.Record, 0, len(in))
	for _, r := range in {
		out = append(out, dnsx.RR(dnsx.Name(r.Name, zone), r.Type, r.Data, r.TTL))
	}
	return out
}

func (p *Provider) change(ctx context.Context, action, zone string, input []libdns.Record) ([]libdns.Record, error) {
	if len(input) == 0 {
		return nil, nil
	}
	rs, err := wire(zone, input, action == "delete")
	if err != nil {
		return nil, err
	}
	out, err := p.call(ctx, request{Action: action, Zone: dnsx.Zone(zone), Records: rs})
	if err != nil {
		return nil, err
	}
	return toLibdns(zone, out.Records), nil
}

// GetRecords lists every record of the zone.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	out, err := p.call(ctx, request{Action: "list", Zone: dnsx.Zone(zone)})
	if err != nil {
		return nil, err
	}
	return toLibdns(zone, out.Records), nil
}

// AppendRecords adds the records; it returns what the receiver added.
func (p *Provider) AppendRecords(ctx context.Context, zone string, input []libdns.Record) ([]libdns.Record, error) {
	return p.change(ctx, "append", zone, input)
}

// SetRecords replaces each input RRset; it returns what the receiver set.
func (p *Provider) SetRecords(ctx context.Context, zone string, input []libdns.Record) ([]libdns.Record, error) {
	return p.change(ctx, "set", zone, input)
}

// DeleteRecords removes the matching records (data empty: the whole
// RRset); it returns what the receiver deleted.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, input []libdns.Record) ([]libdns.Record, error) {
	return p.change(ctx, "delete", zone, input)
}

// ListZones lists the receiver's zones (dnsx.ErrUnsupported when it answers
// 501).
func (p *Provider) ListZones(ctx context.Context) ([]libdns.Zone, error) {
	out, err := p.call(ctx, request{Action: "zones"})
	if err != nil {
		return nil, err
	}
	zones := make([]libdns.Zone, 0, len(out.Zones))
	for _, z := range out.Zones {
		if name := dnsx.Zone(z); name != "" {
			zones = append(zones, libdns.Zone{Name: name + "."})
		}
	}
	return zones, nil
}
