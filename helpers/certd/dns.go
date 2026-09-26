package main

import (
	"context"
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

	"github.com/go-acme/lego/v4/challenge/dns01"
	"github.com/libdns/alidns"
	"github.com/libdns/cloudflare"
	"github.com/libdns/huaweicloud"
	"github.com/libdns/libdns"
)

type dnsProvider interface {
	libdns.RecordGetter
	libdns.RecordAppender
	libdns.RecordSetter
	libdns.RecordDeleter
}

type dnsParams struct {
	Provider    string          `json:"provider"`
	Zone        string          `json:"zone"`
	Credentials json.RawMessage `json:"credentials"`
	Records     []dnsRecord     `json:"records,omitempty"`
}
type dnsRecord struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Data string `json:"data"`
	TTL  int    `json:"ttl"`
}

func providerFor(p dnsParams) (dnsProvider, error) {
	var fields map[string]string
	if json.Unmarshal(p.Credentials, &fields) != nil {
		return nil, fmt.Errorf("invalid DNS credentials")
	}
	if region := fields["region_id"]; region != "" && !regexp.MustCompile(`^[a-z0-9-]{1,32}$`).MatchString(region) {
		return nil, fmt.Errorf("invalid DNS provider region")
	}
	var provider dnsProvider
	switch p.Provider {
	case "test":
		provider = &testDNSProvider{}
	case "cloudflare":
		provider = &cloudflare.Provider{}
	case "alidns":
		provider = &alidns.Provider{}
	case "huaweicloud":
		provider = &huaweicloud.Provider{}
	case "dnspod":
		provider = &dnsPodProvider{}
	default:
		return nil, fmt.Errorf("unsupported DNS provider")
	}
	if err := json.Unmarshal(p.Credentials, provider); err != nil {
		return nil, fmt.Errorf("invalid DNS credentials")
	}
	return provider, nil
}

func dnsCommand(ctx context.Context, command string, raw json.RawMessage) (any, error) {
	var p dnsParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid DNS request")
	}
	if p.Zone == "" || strings.ContainsAny(p.Zone, "/ :\r\n") {
		return nil, fmt.Errorf("invalid DNS zone")
	}
	provider, err := providerFor(p)
	if err != nil {
		return nil, err
	}
	zone := strings.TrimSuffix(p.Zone, ".") + "."
	var records []libdns.Record
	for _, r := range p.Records {
		if r.TTL < 30 || r.TTL > 86400 || len(r.Data) > 4096 || strings.ContainsAny(r.Name, " /\r\n") {
			return nil, fmt.Errorf("invalid DNS record")
		}
		switch r.Type {
		case "TXT", "CNAME", "A", "AAAA":
		default:
			return nil, fmt.Errorf("unsupported DNS record type")
		}
		records = append(records, libdns.RR{Name: r.Name, Type: r.Type, Data: r.Data, TTL: time.Duration(r.TTL) * time.Second})
	}
	var result []libdns.Record
	switch command {
	case "dns.list":
		result, err = provider.GetRecords(ctx, zone)
	case "dns.set":
		result, err = provider.SetRecords(ctx, zone, records)
	case "dns.present":
		result, err = provider.AppendRecords(ctx, zone, records)
	case "dns.cleanup":
		result, err = provider.DeleteRecords(ctx, zone, records)
	default:
		return nil, fmt.Errorf("unsupported DNS operation")
	}
	if err != nil {
		return nil, fmt.Errorf("DNS provider request failed: %w", err)
	}
	out := make([]dnsRecord, 0, len(result))
	for _, record := range result {
		rr := record.RR()
		out = append(out, dnsRecord{Name: rr.Name, Type: rr.Type, Data: rr.Data, TTL: int(rr.TTL / time.Second)})
	}
	return out, nil
}

type dnsChallenge struct {
	mu        sync.Mutex
	session   *protocolSession
	ctx       context.Context
	provider  dnsProvider
	zone      string
	installed map[string][]libdns.Record
}

func (p *dnsChallenge) Present(domain, token, authorization string) error {
	info := dns01.GetChallengeInfo(domain, authorization)
	if !strings.HasSuffix(info.EffectiveFQDN, "."+strings.TrimSuffix(p.zone, ".")+".") {
		return fmt.Errorf("challenge is outside credential zone")
	}
	name := libdns.RelativeName(info.EffectiveFQDN, p.zone)
	intent := []libdns.Record{libdns.TXT{Name: name, Text: info.Value, TTL: time.Minute}}
	if err := p.session.event(map[string]any{"event": "dns01.prepare", "domain": domain, "token": token, "record": dnsRecord{Name: name, Type: "TXT", Data: info.Value, TTL: 60}}); err != nil {
		return err
	}
	p.mu.Lock()
	p.installed[token] = intent
	p.mu.Unlock()
	records, err := p.provider.AppendRecords(p.ctx, p.zone, intent)
	if err == nil {
		p.mu.Lock()
		p.installed[token] = records
		p.mu.Unlock()
	}
	return err
}
func (p *dnsChallenge) CleanUp(domain string, token, _ string) error {
	p.mu.Lock()
	records := p.installed[token]
	p.mu.Unlock()
	if len(records) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(p.ctx), 30*time.Second)
	defer cancel()
	_, err := p.provider.DeleteRecords(ctx, p.zone, records)
	if err != nil {
		return err
	}
	return p.session.event(map[string]any{"event": "dns01.cleanup", "domain": domain, "token": token})
}
func (*dnsChallenge) Timeout() (time.Duration, time.Duration) {
	return 3 * time.Minute, 2 * time.Second
}

// DNSPod's published libdns adapter predates libdns v1. This bounded adapter
// implements the same interface against DNSPod's documented classic API.
type dnsPodProvider struct {
	AuthToken string `json:"auth_token"`
}
type dnsPodRecord struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value string `json:"value"`
	TTL   string `json:"ttl"`
}
type dnsPodResponse struct {
	Status struct {
		Code string `json:"code"`
	} `json:"status"`
	Records []dnsPodRecord `json:"records"`
}

func (p *dnsPodProvider) call(ctx context.Context, method, zone string, fields url.Values) (*dnsPodResponse, error) {
	if p.AuthToken == "" {
		return nil, fmt.Errorf("DNSPod auth_token is required")
	}
	fields.Set("login_token", p.AuthToken)
	fields.Set("format", "json")
	fields.Set("domain", strings.TrimSuffix(zone, "."))
	req, err := http.NewRequestWithContext(ctx, "POST", "https://dnsapi.cn/"+method, strings.NewReader(fields.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("DNSPod transport failed")
	}
	defer res.Body.Close()
	var out dnsPodResponse
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&out) != nil {
		return nil, fmt.Errorf("DNSPod invalid response")
	}
	if out.Status.Code != "1" && !(method == "Record.List" && out.Status.Code == "10") {
		return nil, fmt.Errorf("DNSPod API status %s", out.Status.Code)
	}
	return &out, nil
}
func (p *dnsPodProvider) records(ctx context.Context, zone string) ([]dnsPodRecord, error) {
	var all []dnsPodRecord
	for offset := 0; offset < 100000; offset += 1000 {
		res, err := p.call(ctx, "Record.List", zone, url.Values{"offset": {strconv.Itoa(offset)}, "length": {"1000"}})
		if err != nil {
			return nil, err
		}
		all = append(all, res.Records...)
		if len(res.Records) < 1000 {
			return all, nil
		}
	}
	return nil, fmt.Errorf("DNSPod zone exceeds record limit")
}
func (p *dnsPodProvider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	all, err := p.records(ctx, zone)
	if err != nil {
		return nil, err
	}
	var out []libdns.Record
	for _, r := range all {
		ttl, _ := strconv.Atoi(r.TTL)
		out = append(out, libdns.RR{Name: r.Name, Type: r.Type, Data: r.Value, TTL: time.Duration(ttl) * time.Second})
	}
	return out, nil
}
func (p *dnsPodProvider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	for _, record := range records {
		r := record.RR()
		_, err := p.call(ctx, "Record.Create", zone, url.Values{"sub_domain": {r.Name}, "record_type": {r.Type}, "record_line": {"默认"}, "ttl": {strconv.Itoa(int(r.TTL / time.Second))}, "value": {r.Data}})
		if err != nil {
			return nil, err
		}
	}
	return records, nil
}
func (p *dnsPodProvider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	all, err := p.records(ctx, zone)
	if err != nil {
		return nil, err
	}
	for _, record := range records {
		r := record.RR()
		found := false
		for _, old := range all {
			if old.Name == r.Name && old.Type == r.Type {
				found = true
				_, err = p.call(ctx, "Record.Modify", zone, url.Values{"record_id": {old.ID}, "sub_domain": {r.Name}, "record_type": {r.Type}, "record_line": {"默认"}, "ttl": {strconv.Itoa(int(r.TTL / time.Second))}, "value": {r.Data}})
				if err != nil {
					return nil, err
				}
			}
		}
		if !found {
			if _, err = p.AppendRecords(ctx, zone, []libdns.Record{record}); err != nil {
				return nil, err
			}
		}
	}
	return records, nil
}
func (p *dnsPodProvider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	all, err := p.records(ctx, zone)
	if err != nil {
		return nil, err
	}
	for _, record := range records {
		r := record.RR()
		for _, old := range all {
			if old.Name == r.Name && old.Type == r.Type && old.Value == r.Data {
				if _, err = p.call(ctx, "Record.Remove", zone, url.Values{"record_id": {old.ID}}); err != nil {
					return nil, err
				}
			}
		}
	}
	return records, nil
}
