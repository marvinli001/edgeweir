package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-acme/lego/v4/challenge/dns01"
	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/alidns"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/azure"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/baiducloud"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/bunny"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/cloudflare"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/desec"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/digitalocean"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/dnsla"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/dnspod"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/fixture"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/gandi"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/gcore"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/godaddy"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/googleclouddns"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/hetzner"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/huaweicloud"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/linode"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/namesilo"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/ovh"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/porkbun"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/powerdns"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/rfc2136"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/route53"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/tencentcloud"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/volcengine"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/vultr"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/webhook"
	"github.com/marvinli001/edgeweir/helpers/certd/providers/westcn"
)

// factories has one adapter per catalog entry (a test keeps both in step).
var factories = map[string]dnsx.Factory{
	"alidns":         alidns.New,
	"azure":          azure.New,
	"baiducloud":     baiducloud.New,
	"bunny":          bunny.New,
	"cloudflare":     cloudflare.New,
	"desec":          desec.New,
	"digitalocean":   digitalocean.New,
	"dnsla":          dnsla.New,
	"dnspod":         dnspod.New,
	"gandi":          gandi.New,
	"gcore":          gcore.New,
	"godaddy":        godaddy.New,
	"googleclouddns": googleclouddns.New,
	"hetzner":        hetzner.New,
	"huaweicloud":    huaweicloud.New,
	"linode":         linode.New,
	"namesilo":       namesilo.New,
	"ovh":            ovh.New,
	"porkbun":        porkbun.New,
	"powerdns":       powerdns.New,
	"rfc2136":        rfc2136.New,
	"route53":        route53.New,
	"tencentcloud":   tencentcloud.New,
	"test":           fixture.New,
	"volcengine":     volcengine.New,
	"vultr":          vultr.New,
	"webhook":        webhook.New,
	"westcn":         westcn.New,
}

// providerIDs lists the supported providers (the "providers" command).
func providerIDs() []string {
	ids := make([]string, 0, len(factories))
	for id := range factories {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

type dnsParams struct {
	Provider    string          `json:"provider"`
	Zone        string          `json:"zone"`
	Credentials json.RawMessage `json:"credentials"`
	Records     []dnsRecord     `json:"records,omitempty"`
	// Outbound carries the operator's allow list for endpoints the user
	// configured (never credentials).
	Outbound *struct {
		AllowCIDRs []string `json:"allowCidrs"`
	} `json:"outbound,omitempty"`
}
type dnsRecord struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Data string `json:"data"`
	TTL  int    `json:"ttl"`
	// Line is the canonical resolution line; empty (or "default") is the
	// default line. dns.list returns provider lines without a canonical id
	// as "other:<provider line>".
	Line string `json:"line,omitempty"`
}

// lineMaps are the adapters that write resolution lines; every other
// adapter has the default line only. A test keeps them equal to the
// catalog's lines.
var lineMaps = map[string]dnsx.LineMap{
	"alidns":       alidns.Lines,
	"dnspod":       dnspod.Lines,
	"huaweicloud":  huaweicloud.Lines,
	"tencentcloud": tencentcloud.Lines,
	"test":         fixture.Lines,
}

// supportsLine reports whether the provider's catalog entry lists the line
// ("" is the default line, which every provider has).
func supportsLine(provider, line string) bool {
	if line == "" {
		return true
	}
	for _, l := range catalog[provider].Capabilities.Lines {
		if l == line {
			return true
		}
	}
	return false
}

func providerFor(p dnsParams) (dnsx.Provider, error) {
	factory, ok := factories[p.Provider]
	if !ok {
		return nil, fmt.Errorf("%w: unsupported DNS provider", dnsx.ErrInvalid)
	}
	fields, err := credentialFields(p.Provider, p.Credentials)
	if err != nil {
		return nil, err
	}
	var opts dnsx.Options
	if p.Outbound != nil {
		for _, text := range p.Outbound.AllowCIDRs {
			prefix, err := netip.ParsePrefix(text)
			if err != nil {
				return nil, fmt.Errorf("%w: invalid outbound allow list", dnsx.ErrInvalid)
			}
			opts.AllowCIDRs = append(opts.AllowCIDRs, prefix.Masked())
		}
	}
	return factory(fields, opts)
}

var recordTypes = map[string]bool{"TXT": true, "CNAME": true, "A": true, "AAAA": true, "ALIAS": true}

// Record names are "@" or relative names (a leading "*" label allowed); zones
// are plain host names. Anything else (empty names, absolute names, paths,
// query characters) is refused before it reaches an adapter.
var (
	recordName = regexp.MustCompile(`^(?i)(@|\*|(\*\.)?[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*)$`)
	zoneName   = regexp.MustCompile(`^(?i)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.?$`)
	// otherLine is a provider line without a canonical id as dns.list
	// returns it (no control characters or spaces).
	otherLine = regexp.MustCompile(`^other:[^\x00-\x20\x7f]+$`)
)

func dnsCommand(ctx context.Context, command string, raw json.RawMessage) (any, error) {
	var p dnsParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("%w: invalid DNS request", dnsx.ErrInvalid)
	}
	if command != "dns.zones" && (len(p.Zone) > 253 || !zoneName.MatchString(p.Zone)) {
		return nil, fmt.Errorf("%w: invalid DNS zone", dnsx.ErrInvalid)
	}
	zone := strings.TrimSuffix(p.Zone, ".") + "."
	var records []libdns.Record
	_, known := catalog[p.Provider] // unknown providers fail in providerFor
	for _, r := range p.Records {
		if r.TTL < 30 || r.TTL > 86400 || len(r.Data) > 4096 || len(r.Name) > 253 || !recordName.MatchString(r.Name) {
			return nil, fmt.Errorf("%w: invalid DNS record", dnsx.ErrInvalid)
		}
		if !recordTypes[r.Type] {
			return nil, fmt.Errorf("%w: unsupported DNS record type", dnsx.ErrInvalid)
		}
		line := dnsx.NormalizeLine(r.Line)
		switch {
		case dnsx.IsOtherLine(line):
			// A line dns.list returned without a canonical id: such records
			// can be deleted, never written.
			if command != "dns.cleanup" || len(line) > 64 || !otherLine.MatchString(line) {
				return nil, fmt.Errorf("%w: invalid DNS resolution line", dnsx.ErrInvalid)
			}
			if known && len(catalog[p.Provider].Capabilities.Lines) < 2 {
				return nil, fmt.Errorf("%w: this provider has no resolution lines", dnsx.ErrUnsupported)
			}
		case !dnsx.IsCanonicalLine(line):
			return nil, fmt.Errorf("%w: invalid DNS resolution line", dnsx.ErrInvalid)
		case known && !supportsLine(p.Provider, line):
			return nil, fmt.Errorf("%w: this provider has no resolution line %s", dnsx.ErrUnsupported, line)
		}
		records = append(records, dnsx.OnLine(libdns.RR{Name: r.Name, Type: r.Type, Data: r.Data, TTL: time.Duration(r.TTL) * time.Second}, line))
	}
	provider, err := providerFor(p)
	if err != nil {
		return nil, err
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
	case "dns.test":
		result, err = provider.GetRecords(ctx, zone)
		if err == nil {
			return map[string]int{"records": len(result)}, nil
		}
	case "dns.zones":
		lister, ok := provider.(libdns.ZoneLister)
		if !ok {
			return nil, fmt.Errorf("%w: this provider cannot list zones", dnsx.ErrUnsupported)
		}
		zones, err := lister.ListZones(ctx)
		if err != nil {
			return nil, fmt.Errorf("DNS provider request failed: %w", err)
		}
		names := make([]string, 0, len(zones))
		for _, z := range zones {
			names = append(names, strings.TrimSuffix(strings.ToLower(z.Name), "."))
		}
		sort.Strings(names)
		return names, nil
	default:
		return nil, fmt.Errorf("%w: unsupported DNS operation", dnsx.ErrInvalid)
	}
	if err != nil {
		return nil, fmt.Errorf("DNS provider request failed: %w", err)
	}
	out := make([]dnsRecord, 0, len(result))
	for _, record := range result {
		rr := record.RR()
		out = append(out, dnsRecord{Name: rr.Name, Type: rr.Type, Data: rr.Data, TTL: int(rr.TTL / time.Second), Line: dnsx.LineOf(record)})
	}
	return out, nil
}

type dnsChallenge struct {
	mu        sync.Mutex
	session   *protocolSession
	ctx       context.Context
	provider  dnsx.Provider
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
	// Cleanup deletes exactly this record (name, TXT, value), never what the
	// provider echoed back: an empty value there would delete the whole set,
	// including a sibling challenge (apex and wildcard) still in use.
	p.mu.Lock()
	p.installed[token] = intent
	p.mu.Unlock()
	_, err := p.provider.AppendRecords(p.ctx, p.zone, intent)
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
