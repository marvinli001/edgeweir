// Package rfc2136 manages a zone on a server that accepts TSIG-signed
// (RFC 8945) dynamic updates (RFC 2136), e.g. BIND, Knot DNS or PowerDNS.
// Records are read with a TSIG-signed zone transfer (AXFR, RFC 5936), so the
// server must allow AXFR for the key as well as updates. Every exchange uses
// TCP ("requestors who require an accurate response code must use TCP",
// RFC 2136 section 3.8) through the outbound address policy
// (dnsx.DialPolicy), and every successful answer must carry a valid TSIG
// signature.
//
// AppendRecords adds RRs; SetRecords deletes each input RRset and adds the
// input RRs in the same UPDATE message (atomic on the server);
// DeleteRecords deletes the given RRs, or the whole RRset when data is empty.
// Updates cannot tell which RRs existed, so Append/Set/Delete return their
// input.
package rfc2136

import (
	"context"
	"crypto/hmac"
	"crypto/sha1" // hmac-sha1 is still a TSIG algorithm (RFC 8945 section 6)
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/libdns/libdns"
	"github.com/miekg/dns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	maxRecords = 100000
	ioTimeout  = 30 * time.Second
	fudge      = 300
	opUpdate   = "update"
	opTransfer = "zone transfer"
)

var algorithms = map[string]string{
	"hmac-sha256": dns.HmacSHA256,
	"hmac-sha512": dns.HmacSHA512,
	"hmac-sha384": dns.HmacSHA384,
	"hmac-sha224": dns.HmacSHA224,
	"hmac-sha1":   dns.HmacSHA1,
}

// Provider updates zones on one server with one TSIG key.
type Provider struct {
	server string // host:port
	key    tsigKey
	allow  []netip.Prefix
	now    func() time.Time
	mu     sync.Mutex // one change at a time per provider
}

// New builds the adapter from the catalog fields (server, tsig_key_name,
// tsig_algorithm, tsig_secret).
func New(fields map[string]string, opts dnsx.Options) (dnsx.Provider, error) {
	server, err := serverAddress(fields["server"])
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(fields["tsig_key_name"])
	if _, ok := dns.IsDomainName(name); !ok || name == "" || name == "." || strings.ContainsAny(name, " \t\\") {
		return nil, fmt.Errorf("%w: tsig_key_name must be a key name such as \"edgeweir-key\"", dnsx.ErrInvalid)
	}
	algorithm := strings.ToLower(strings.TrimSpace(fields["tsig_algorithm"]))
	if algorithm == "" {
		algorithm = "hmac-sha256"
	}
	alg, ok := algorithms[algorithm]
	if !ok {
		return nil, fmt.Errorf("%w: unsupported tsig_algorithm", dnsx.ErrInvalid)
	}
	secret, err := base64.StdEncoding.DecodeString(strings.TrimSpace(fields["tsig_secret"]))
	if err != nil || len(secret) == 0 {
		return nil, fmt.Errorf("%w: tsig_secret must be base64", dnsx.ErrInvalid)
	}
	return &Provider{
		server: server,
		key:    tsigKey{name: dns.CanonicalName(name), algorithm: alg, secret: secret},
		allow:  opts.AllowCIDRs,
		now:    time.Now,
	}, nil
}

// serverAddress accepts host, host:port, an IP address or [IPv6]:port
// (default port 53).
func serverAddress(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	invalid := fmt.Errorf("%w: server must be a host name or IP address with an optional port", dnsx.ErrInvalid)
	if ip, err := netip.ParseAddr(strings.Trim(raw, "[]")); err == nil && ip.Zone() == "" {
		return net.JoinHostPort(ip.String(), "53"), nil
	}
	host, port := raw, "53"
	if h, p, err := net.SplitHostPort(raw); err == nil {
		host, port = h, p
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return "", invalid
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		if ip.Zone() != "" {
			return "", invalid
		}
		return net.JoinHostPort(ip.String(), port), nil
	}
	if !validHost(host) {
		return "", invalid
	}
	return net.JoinHostPort(strings.TrimSuffix(host, "."), port), nil
}

func validHost(host string) bool {
	host = strings.TrimSuffix(host, ".")
	if host == "" || len(host) > 253 {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
				return false
			}
		}
	}
	return true
}

// tsigKey signs and verifies with one key. The response must use the
// request's key name and algorithm.
type tsigKey struct {
	name, algorithm string
	secret          []byte
}

func (k tsigKey) mac(msg []byte, t *dns.TSIG) ([]byte, error) {
	if !strings.EqualFold(t.Hdr.Name, k.name) || !strings.EqualFold(dns.CanonicalName(t.Algorithm), k.algorithm) {
		return nil, dns.ErrKeyAlg
	}
	var h func() hash.Hash
	switch k.algorithm {
	case dns.HmacSHA1:
		h = sha1.New
	case dns.HmacSHA224:
		h = sha256.New224
	case dns.HmacSHA256:
		h = sha256.New
	case dns.HmacSHA384:
		h = sha512.New384
	case dns.HmacSHA512:
		h = sha512.New
	default:
		return nil, dns.ErrKeyAlg
	}
	m := hmac.New(h, k.secret)
	m.Write(msg)
	return m.Sum(nil), nil
}

func (k tsigKey) Generate(msg []byte, t *dns.TSIG) ([]byte, error) { return k.mac(msg, t) }

func (k tsigKey) Verify(msg []byte, t *dns.TSIG) error {
	want, err := k.mac(msg, t)
	if err != nil {
		return err
	}
	got, err := hex.DecodeString(t.MAC)
	if err != nil || !hmac.Equal(want, got) {
		return dns.ErrSig
	}
	return nil
}

// session is one TCP connection to the server.
type session struct {
	conn *dns.Conn
	stop func() bool
}

func (p *Provider) dial(ctx context.Context) (*session, error) {
	c, err := dnsx.DialPolicy(ctx, p.allow, "tcp", p.server)
	if err != nil {
		if errors.Is(err, dnsx.ErrRefused) || errors.Is(err, context.Canceled) {
			return nil, err
		}
		return nil, fmt.Errorf("%w: %s", dnsx.ErrUnreachable, dnsx.Short(err.Error()))
	}
	// Closing the connection unblocks reads when the context ends.
	return &session{conn: &dns.Conn{Conn: c}, stop: context.AfterFunc(ctx, func() { _ = c.Close() })}, nil
}

func (s *session) close() {
	s.stop()
	_ = s.conn.Close()
}

func (s *session) deadline(ctx context.Context) {
	d := time.Now().Add(ioTimeout)
	if cd, ok := ctx.Deadline(); ok && cd.Before(d) {
		d = cd
	}
	_ = s.conn.SetDeadline(d)
}

// send signs and writes a request; it returns the request MAC.
func (p *Provider) send(ctx context.Context, s *session, m *dns.Msg) (string, error) {
	m.SetTsig(p.key.name, p.key.algorithm, fudge, p.now().Unix())
	buf, mac, err := dns.TsigGenerateWithProvider(m, p.key, "", false)
	if err != nil {
		return "", fmt.Errorf("%w: cannot sign the request", dnsx.ErrInvalid)
	}
	s.deadline(ctx)
	if _, err := s.conn.Write(buf); err != nil {
		return "", p.ioError(ctx, err)
	}
	return mac, nil
}

// receive reads one answer. A successful answer must carry a TSIG that
// verifies against the previous MAC (the request's for the first answer; the
// previous answer's, timers only, inside a zone transfer, RFC 8945 section
// 5.3.1).
func (p *Provider) receive(ctx context.Context, s *session, op string, id uint16, prevMAC string, timersOnly bool) (*dns.Msg, string, error) {
	s.deadline(ctx)
	raw, err := s.conn.ReadMsgHeader(nil)
	if err != nil {
		return nil, "", p.ioError(ctx, err)
	}
	m := new(dns.Msg)
	if err := m.Unpack(raw); err != nil || !m.Response || m.Id != id {
		return nil, "", fmt.Errorf("%w: malformed answer", dnsx.ErrProvider)
	}
	t := m.IsTsig()
	switch {
	case t != nil && t.Error != dns.RcodeSuccess:
		return nil, "", fmt.Errorf("%w: server rejected the TSIG key (%s)", dnsx.ErrAuth, tsigError(t.Error))
	case m.Rcode != dns.RcodeSuccess:
		// Error answers only fail the operation, so they are reported
		// without requiring a signature (miekg/dns does not verify
		// NOTAUTH answers at all).
		return nil, "", rcodeError(op, m.Rcode)
	case t == nil:
		return nil, "", fmt.Errorf("%w: unsigned answer", dnsx.ErrAuth)
	}
	if err := dns.TsigVerifyWithProvider(raw, p.key, prevMAC, timersOnly); err != nil {
		if errors.Is(err, dns.ErrTime) {
			return nil, "", fmt.Errorf("%w: answer signed outside the %d s time window (clock skew)", dnsx.ErrAuth, fudge)
		}
		return nil, "", fmt.Errorf("%w: answer signature does not verify", dnsx.ErrAuth)
	}
	return m, t.MAC, nil
}

func (p *Provider) ioError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var timeout interface{ Timeout() bool }
	if errors.As(err, &timeout) && timeout.Timeout() {
		return fmt.Errorf("%w: timed out", dnsx.ErrUnreachable)
	}
	return fmt.Errorf("%w: %s", dnsx.ErrUnreachable, dnsx.Short(err.Error()))
}

func tsigError(code uint16) string {
	switch code {
	case dns.RcodeBadSig:
		return "BADSIG"
	case dns.RcodeBadKey:
		return "BADKEY"
	case dns.RcodeBadTime:
		return "BADTIME: clock skew"
	case dns.RcodeBadTrunc:
		return "BADTRUNC"
	}
	return strconv.Itoa(int(code))
}

// rcodeError maps an answer's RCODE (op: "update" or "zone transfer").
func rcodeError(op string, rcode int) error {
	name := dns.RcodeToString[rcode]
	if name == "" {
		name = strconv.Itoa(rcode)
	}
	switch rcode {
	case dns.RcodeRefused:
		if op == opTransfer {
			return fmt.Errorf("%w: zone transfer REFUSED (the server must allow AXFR for this key)", dnsx.ErrAuth)
		}
		return fmt.Errorf("%w: update REFUSED (the server's update policy does not permit this key)", dnsx.ErrAuth)
	case dns.RcodeNotAuth:
		return fmt.Errorf("%w: %s NOTAUTH (the server is not authoritative for the zone)", dnsx.ErrZoneNotFound, op)
	case dns.RcodeNotZone:
		return fmt.Errorf("%w: %s NOTZONE (a name is outside the zone)", dnsx.ErrInvalid, op)
	case dns.RcodeServerFailure:
		return fmt.Errorf("%w: %s SERVFAIL", dnsx.ErrUnreachable, op)
	case dns.RcodeNotImplemented:
		return fmt.Errorf("%w: %s NOTIMP", dnsx.ErrUnsupported, op)
	}
	return fmt.Errorf("%w: %s %s", dnsx.ErrProvider, op, name)
}

func origin(zone string) string { return dnsx.Zone(zone) + "." }

// GetRecords transfers the zone (AXFR). DNSSEC signatures and chain records
// (RRSIG, NSEC, NSEC3) are skipped.
func (p *Provider) GetRecords(ctx context.Context, zone string) ([]libdns.Record, error) {
	o := origin(zone)
	s, err := p.dial(ctx)
	if err != nil {
		return nil, err
	}
	defer s.close()
	q := new(dns.Msg)
	q.SetAxfr(o)
	mac, err := p.send(ctx, s, q)
	if err != nil {
		return nil, err
	}
	var out []libdns.Record
	soas := 0
	for first := true; ; first = false {
		m, next, err := p.receive(ctx, s, opTransfer, q.Id, mac, !first)
		if err != nil {
			return nil, err
		}
		mac = next
		if len(m.Answer) == 0 {
			return nil, fmt.Errorf("%w: empty zone transfer message", dnsx.ErrProvider)
		}
		for i, rr := range m.Answer {
			h := rr.Header()
			if first && i == 0 && h.Rrtype != dns.TypeSOA {
				return nil, fmt.Errorf("%w: zone transfer does not start with SOA", dnsx.ErrProvider)
			}
			switch h.Rrtype {
			case dns.TypeSOA:
				if soas++; soas == 2 {
					return out, nil
				}
			case dns.TypeRRSIG, dns.TypeNSEC, dns.TypeNSEC3:
				continue
			}
			if len(out) == maxRecords {
				return nil, fmt.Errorf("%w: zone exceeds %d records", dnsx.ErrProvider, maxRecords)
			}
			out = append(out, toLibdns(rr, o))
		}
	}
}

// update sends one UPDATE message for the zone.
func (p *Provider) update(ctx context.Context, m *dns.Msg) error {
	if len(m.Ns) == 0 {
		return nil
	}
	s, err := p.dial(ctx)
	if err != nil {
		return err
	}
	defer s.close()
	mac, err := p.send(ctx, s, m)
	if err != nil {
		return err
	}
	_, _, err = p.receive(ctx, s, opUpdate, m.Id, mac, false)
	return err
}

// AppendRecords adds the records.
func (p *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	o := origin(zone)
	m := new(dns.Msg).SetUpdate(o)
	for _, r := range dnsx.RRs(records) {
		rr, err := toDNS(r, o)
		if err != nil {
			return nil, err
		}
		m.Insert([]dns.RR{rr})
	}
	if err := p.update(ctx, m); err != nil {
		return nil, err
	}
	return records, nil
}

// SetRecords deletes each input RRset and adds the input records, in one
// UPDATE message.
func (p *Provider) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	o := origin(zone)
	m := new(dns.Msg).SetUpdate(o)
	cleared, added := map[string]bool{}, map[string]bool{}
	var adds []dns.RR
	for _, r := range dnsx.RRs(records) {
		rr, err := toDNS(r, o)
		if err != nil {
			return nil, err
		}
		if key := dnsx.SetKey(r); !cleared[key] {
			cleared[key] = true
			m.RemoveRRset([]dns.RR{rr})
		}
		if key := dnsx.Key(r); !added[key] {
			added[key] = true
			adds = append(adds, rr)
		}
	}
	m.Insert(adds)
	if err := p.update(ctx, m); err != nil {
		return nil, err
	}
	return records, nil
}

// DeleteRecords deletes the given records (data empty: the whole RRset).
func (p *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	o := origin(zone)
	m := new(dns.Msg).SetUpdate(o)
	var done []libdns.Record
	for _, r := range dnsx.RRs(records) {
		if r.Type == "" {
			continue // name-only deletes are not supported (dnsx.Matches needs a type)
		}
		if r.Data == "" {
			typ, name, err := typeAndName(r, o)
			if err != nil {
				return nil, err
			}
			m.RemoveRRset([]dns.RR{&dns.ANY{Hdr: dns.RR_Header{Name: name, Rrtype: typ, Class: dns.ClassINET}}})
		} else {
			rr, err := toDNS(r, o)
			if err != nil {
				return nil, err
			}
			m.Remove([]dns.RR{rr})
		}
		done = append(done, r)
	}
	if err := p.update(ctx, m); err != nil {
		return nil, err
	}
	return done, nil
}

func typeAndName(r libdns.RR, o string) (uint16, string, error) {
	typ, ok := dns.StringToType[strings.ToUpper(r.Type)]
	if !ok || typ == dns.TypeANY || typ == dns.TypeAXFR || typ == dns.TypeIXFR || typ == dns.TypeTSIG || typ == dns.TypeOPT {
		return 0, "", fmt.Errorf("%w: unsupported record type %q", dnsx.ErrInvalid, dnsx.Short(r.Type))
	}
	name := strings.ToLower(libdns.AbsoluteName(r.Name, o))
	if _, ok := dns.IsDomainName(name); !ok || !dns.IsSubDomain(o, name) {
		return 0, "", fmt.Errorf("%w: record name %q is outside the zone", dnsx.ErrInvalid, dnsx.Short(r.Name))
	}
	return typ, name, nil
}

// toDNS builds the wire RR for a libdns record.
func toDNS(r libdns.RR, o string) (dns.RR, error) {
	typ, name, err := typeAndName(r, o)
	if err != nil {
		return nil, err
	}
	hdr := dns.RR_Header{Name: name, Rrtype: typ, Class: dns.ClassINET, Ttl: uint32(dnsx.Seconds(r.TTL))}
	invalid := fmt.Errorf("%w: invalid %s data %q", dnsx.ErrInvalid, dns.TypeToString[typ], dnsx.Short(r.Data))
	switch typ {
	case dns.TypeA:
		ip, err := netip.ParseAddr(r.Data)
		if err != nil || !ip.Is4() {
			return nil, invalid
		}
		return &dns.A{Hdr: hdr, A: ip.AsSlice()}, nil
	case dns.TypeAAAA:
		ip, err := netip.ParseAddr(r.Data)
		if err != nil || !ip.Is6() || ip.Is4In6() || ip.Zone() != "" {
			return nil, invalid
		}
		return &dns.AAAA{Hdr: hdr, AAAA: ip.AsSlice()}, nil
	case dns.TypeCNAME:
		target := dns.Fqdn(r.Data)
		if _, ok := dns.IsDomainName(target); !ok || r.Data == "" || strings.ContainsAny(target, " \t") {
			return nil, invalid
		}
		return &dns.CNAME{Hdr: hdr, Target: target}, nil
	case dns.TypeTXT:
		return &dns.TXT{Hdr: hdr, Txt: txtStrings(r.Data)}, nil
	}
	// Other types: zone-file presentation form, one line.
	if strings.ContainsFunc(r.Data, func(c rune) bool { return c < 0x20 || c == 0x7f }) {
		return nil, invalid
	}
	rr, err := dns.NewRR(fmt.Sprintf("%s %d IN %s %s", name, hdr.Ttl, dns.TypeToString[typ], r.Data))
	if err != nil || rr == nil || rr.Header().Rrtype != typ {
		return nil, invalid
	}
	return rr, nil
}

// toLibdns converts a transferred RR.
func toLibdns(rr dns.RR, o string) libdns.RR {
	h := rr.Header()
	var data string
	switch v := rr.(type) {
	case *dns.A:
		data = v.A.String()
	case *dns.AAAA:
		data = v.AAAA.String()
	case *dns.CNAME:
		data = v.Target
	case *dns.TXT:
		data = joinTXT(v.Txt)
	default:
		data = strings.TrimPrefix(rr.String(), h.String())
	}
	typ := dns.TypeToString[h.Rrtype]
	if typ == "" {
		typ = "TYPE" + strconv.Itoa(int(h.Rrtype))
	}
	return dnsx.RR(dnsx.Relative(h.Name, o), typ, data, int(h.Ttl))
}

// txtStrings splits raw TXT text into character-strings of at most 255
// bytes in miekg/dns presentation form ('"', '\' and non-printable bytes
// escaped).
func txtStrings(text string) []string {
	var out []string
	for first := true; first || text != ""; first = false {
		chunk := text
		if len(chunk) > 255 {
			chunk = chunk[:255]
		}
		text = text[len(chunk):]
		var b strings.Builder
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
		out = append(out, b.String())
	}
	return out
}

// joinTXT decodes and concatenates miekg/dns TXT strings.
func joinTXT(parts []string) string {
	var out []byte
	for _, s := range parts {
		for i := 0; i < len(s); i++ {
			c := s[i]
			if c == '\\' && i+1 < len(s) {
				if i+3 < len(s) && isDigit(s[i+1]) && isDigit(s[i+2]) && isDigit(s[i+3]) {
					if n := int(s[i+1]-'0')*100 + int(s[i+2]-'0')*10 + int(s[i+3]-'0'); n < 256 {
						out = append(out, byte(n))
						i += 3
						continue
					}
				}
				i++
				c = s[i]
			}
			out = append(out, c)
		}
	}
	return string(out)
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }
