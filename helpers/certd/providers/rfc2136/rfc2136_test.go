package rfc2136

// Protocol references: RFC 2136 (UPDATE sections and delete semantics,
// https://www.rfc-editor.org/rfc/rfc2136), RFC 8945 (TSIG, error codes and
// multi-message signing, https://www.rfc-editor.org/rfc/rfc8945) and RFC 5936
// (AXFR, https://www.rfc-editor.org/rfc/rfc5936). The server is an
// in-process miekg/dns server on 127.0.0.1 that verifies TSIG itself.

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/libdns/libdns"
	"github.com/miekg/dns"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnstest"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

const (
	keyName = "edgeweir-key."
	secret  = "c2VjcmV0LWtleS1mb3ItZWRnZXdlaXItdGVzdHMhIQ==" // base64 of the test key
	other   = "b3RoZXItc2VjcmV0LW5vdC10aGUtc2VydmVycy1rZXk="
)

var loopback = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}

// fake is an authoritative server for example.com. that records what it
// receives. TSIG is verified by miekg/dns with the server's own secrets.
type fake struct {
	addr     string
	mu       sync.Mutex
	msgs     []*dns.Msg
	tsig     []error
	udp      int
	rcode    int  // answer to updates and transfers
	unsigned bool // answer without TSIG
	forged   bool // answer signed with another secret
	split    int  // RRs per AXFR message
}

func serve(t *testing.T) *fake {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fake{addr: ln.Addr().String(), split: 3}
	accept := func(dns.Header) dns.MsgAcceptAction { return dns.MsgAccept }
	secrets := map[string]string{keyName: secret}
	start := func(srv *dns.Server) {
		started := make(chan struct{})
		srv.NotifyStartedFunc = func() { close(started) }
		go func() { _ = srv.ActivateAndServe() }()
		<-started
		t.Cleanup(func() { _ = srv.Shutdown() })
	}
	start(&dns.Server{Listener: ln, TsigSecret: secrets, MsgAcceptFunc: accept, Handler: dns.HandlerFunc(f.handle)})
	// UDP on the same port: the adapter must never use it.
	if pc, err := net.ListenPacket("udp", f.addr); err == nil {
		start(&dns.Server{PacketConn: pc, TsigSecret: secrets, MsgAcceptFunc: accept, Handler: dns.HandlerFunc(func(w dns.ResponseWriter, r *dns.Msg) {
			f.mu.Lock()
			f.udp++
			f.mu.Unlock()
		})})
	}
	t.Cleanup(func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.udp != 0 {
			t.Errorf("%d UDP messages; every exchange must use TCP", f.udp)
		}
	})
	return f
}

// answer sets how updates and transfers are answered.
func (f *fake) answer(rcode int, unsigned bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rcode, f.unsigned = rcode, unsigned
}

func (f *fake) received() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.msgs)
}

func fixture() []dns.RR {
	var out []dns.RR
	for _, line := range []string{
		"example.com. 3600 IN SOA ns1.example.com. hostmaster.example.com. 2024010101 3600 600 604800 300",
		"example.com. 3600 IN NS ns1.example.com.",
		"www.example.com. 600 IN A 192.0.2.1",
		"www.example.com. 600 IN A 192.0.2.2",
		"www.example.com. 600 IN AAAA 2001:db8::1",
		"www.example.com. 600 IN RRSIG A 13 3 600 20250101000000 20240101000000 12345 example.com. aGVsbG8=",
		`example.com. 600 IN TXT "keep \"me\""`,
		`_acme-challenge.example.com. 60 IN TXT "caf\195\169" "x"`,
		"cdn.example.com. 300 IN CNAME edge.example.net.",
		"example.com. 600 IN MX 10 mail.example.com.",
	} {
		rr, err := dns.NewRR(line)
		if err != nil {
			panic(err)
		}
		out = append(out, rr)
	}
	return out
}

func (f *fake) handle(w dns.ResponseWriter, r *dns.Msg) {
	f.mu.Lock()
	f.msgs = append(f.msgs, r.Copy())
	f.tsig = append(f.tsig, w.TsigStatus())
	rcode, unsigned, forged, split := f.rcode, f.unsigned, f.forged, f.split
	f.mu.Unlock()
	reply := new(dns.Msg)
	t := r.IsTsig()
	if t == nil {
		_ = w.WriteMsg(reply.SetRcode(r, dns.RcodeRefused))
		return
	}
	if status := w.TsigStatus(); status != nil {
		reply.SetRcode(r, dns.RcodeNotAuth)
		reply.SetTsig(t.Hdr.Name, t.Algorithm, 300, time.Now().Unix())
		code := dns.RcodeBadSig
		switch {
		case errors.Is(status, dns.ErrSecret):
			code = dns.RcodeBadKey
		case errors.Is(status, dns.ErrTime):
			code = dns.RcodeBadTime
		}
		reply.IsTsig().Error = uint16(code)
		_ = w.WriteMsg(reply)
		return
	}
	if r.Opcode == dns.OpcodeQuery && r.Question[0].Qtype == dns.TypeAXFR && rcode == dns.RcodeSuccess {
		zone := fixture()
		all := append(zone, zone[0]) // closing SOA
		ch := make(chan *dns.Envelope)
		done := make(chan struct{})
		go func() { _ = new(dns.Transfer).Out(w, r, ch); close(done) }()
		for i := 0; i < len(all); i += split {
			ch <- &dns.Envelope{RR: all[i:min(i+split, len(all))]}
		}
		close(ch)
		<-done
		return
	}
	reply.SetRcode(r, rcode)
	if forged {
		reply.SetTsig(t.Hdr.Name, t.Algorithm, 300, time.Now().Unix())
		buf, _, err := dns.TsigGenerate(reply, other, t.MAC, false)
		if err == nil {
			_, _ = w.Write(buf)
		}
		return
	}
	if !unsigned {
		reply.SetTsig(t.Hdr.Name, t.Algorithm, 300, time.Now().Unix())
	}
	_ = w.WriteMsg(reply)
}

// last returns the last received message and asserts its TSIG verified.
func (f *fake) last(t *testing.T) *dns.Msg {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.msgs) == 0 {
		t.Fatal("server received nothing")
	}
	if err := f.tsig[len(f.tsig)-1]; err != nil {
		t.Fatalf("server could not verify the TSIG: %v", err)
	}
	return f.msgs[len(f.msgs)-1]
}

func provider(t *testing.T, f *fake, extra map[string]string) *Provider {
	t.Helper()
	fields := map[string]string{"server": f.addr, "tsig_key_name": "Edgeweir-Key", "tsig_secret": secret}
	for k, v := range extra {
		fields[k] = v
	}
	p, err := New(fields, dnsx.Options{AllowCIDRs: loopback})
	if err != nil {
		t.Fatal(err)
	}
	return p.(*Provider)
}

// assertUpdate checks the header, zone and prerequisite sections and the
// TSIG of an UPDATE, and returns its update section as zone-file lines.
func assertUpdate(t *testing.T, m *dns.Msg, algorithm string) []string {
	t.Helper()
	if m.Opcode != dns.OpcodeUpdate || len(m.Question) != 1 || m.Question[0] != (dns.Question{Name: "example.com.", Qtype: dns.TypeSOA, Qclass: dns.ClassINET}) {
		t.Fatalf("zone section: opcode %d %v", m.Opcode, m.Question)
	}
	if len(m.Answer) != 0 {
		t.Fatalf("prerequisites: %v", m.Answer)
	}
	ts := m.IsTsig()
	if ts == nil || ts.Hdr.Name != keyName || ts.Algorithm != algorithm || ts.Fudge != 300 {
		t.Fatalf("tsig: %v", ts)
	}
	var lines []string
	for _, rr := range m.Ns {
		lines = append(lines, strings.Join(strings.Fields(rr.String()), " "))
	}
	return lines
}

func equal(t *testing.T, got, want []string) {
	t.Helper()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("update section:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestGetRecords(t *testing.T) {
	f := serve(t)
	records, err := provider(t, f, nil).GetRecords(context.Background(), "Example.com.")
	if err != nil {
		t.Fatal(err)
	}
	q := f.last(t)
	if q.Question[0] != (dns.Question{Name: "example.com.", Qtype: dns.TypeAXFR, Qclass: dns.ClassINET}) || q.IsTsig().Hdr.Name != keyName {
		t.Fatalf("query: %v", q)
	}
	// SOA once, NS, 2 A, AAAA, 2 TXT, CNAME, MX; the RRSIG is skipped.
	if len(records) != 9 {
		t.Fatalf("records: %+v", records)
	}
	for _, want := range [][3]string{
		{"@", "SOA", "ns1.example.com. hostmaster.example.com. 2024010101 3600 600 604800 300"},
		{"www", "A", "192.0.2.1"}, {"www", "A", "192.0.2.2"}, {"www", "AAAA", "2001:db8::1"},
		{"@", "TXT", `keep "me"`}, {"_acme-challenge", "TXT", "caféx"}, {"cdn", "CNAME", "edge.example.net."},
		{"@", "MX", "10 mail.example.com."},
	} {
		if !dnstest.Has(records, want[0], want[1], want[2]) {
			t.Errorf("missing %v in %+v", want, records)
		}
	}
	if records[1].RR().TTL != 3600*time.Second {
		t.Errorf("ttl: %v", records[1].RR().TTL)
	}
}

func TestGetRecordsSingleMessageTransfer(t *testing.T) {
	f := serve(t)
	f.mu.Lock()
	f.split = 100
	f.mu.Unlock()
	records, err := provider(t, f, nil).GetRecords(context.Background(), "example.com.")
	if err != nil || len(records) != 9 {
		t.Fatalf("records %v err %v", records, err)
	}
}

func TestAppendRecords(t *testing.T) {
	f := serve(t)
	p := provider(t, f, nil)
	signed := time.Now().Add(-time.Minute).Truncate(time.Second)
	p.now = func() time.Time { return signed }
	done, err := p.AppendRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", `token "1"`, 60),
		dnstest.A("www", "192.0.2.3", 600),
	})
	if err != nil || len(done) != 2 {
		t.Fatalf("done %v err %v", done, err)
	}
	m := f.last(t)
	if m.IsTsig().TimeSigned != uint64(signed.Unix()) {
		t.Fatalf("time signed %d", m.IsTsig().TimeSigned)
	}
	equal(t, assertUpdate(t, m, dns.HmacSHA256), []string{
		`_acme-challenge.example.com. 60 IN TXT "token \"1\""`,
		"www.example.com. 600 IN A 192.0.2.3",
	})
}

func TestSetRecordsReplacesTheRRset(t *testing.T) {
	f := serve(t)
	// www A becomes {192.0.2.1, 192.0.2.3} (192.0.2.2 goes); the CNAME
	// changes; www AAAA and every other RRset are not mentioned.
	_, err := provider(t, f, map[string]string{"tsig_algorithm": "hmac-sha512"}).SetRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.A("www", "192.0.2.1", 60), dnstest.A("www", "192.0.2.3", 60), dnstest.A("www", "192.0.2.3", 60),
		dnstest.CNAME("cdn", "edge2.example.net", 300),
	})
	if err != nil {
		t.Fatal(err)
	}
	equal(t, assertUpdate(t, f.last(t), dns.HmacSHA512), []string{
		"www.example.com. 0 CLASS255 A", // class ANY: delete the RRset
		"cdn.example.com. 0 CLASS255 CNAME",
		"www.example.com. 60 IN A 192.0.2.1",
		"www.example.com. 60 IN A 192.0.2.3",
		"cdn.example.com. 300 IN CNAME edge2.example.net.",
	})
}

func TestDeleteRecords(t *testing.T) {
	f := serve(t)
	deleted, err := provider(t, f, nil).DeleteRecords(context.Background(), "example.com.", []libdns.Record{
		dnstest.TXT("_acme-challenge", "token-1", 60), // one RR
		libdns.RR{Name: "cdn", Type: "CNAME"},         // the whole RRset
		libdns.RR{Name: "www"},                        // no type: ignored
	})
	if err != nil || len(deleted) != 2 {
		t.Fatalf("deleted %v err %v", deleted, err)
	}
	equal(t, assertUpdate(t, f.last(t), dns.HmacSHA256), []string{
		`_acme-challenge.example.com. 0 NONE TXT "token-1"`,
		"cdn.example.com. 0 CLASS255 CNAME",
	})
}

func TestErrors(t *testing.T) {
	ctx := context.Background()
	add := []libdns.Record{dnstest.TXT("_acme-challenge", "x", 60)}
	f := serve(t)

	_, err := provider(t, f, map[string]string{"tsig_secret": other}).AppendRecords(ctx, "example.com.", add)
	dnstest.NoSecret(t, err, other, secret)
	if !errors.Is(err, dnsx.ErrAuth) || dnsx.Code(err) != "dns_auth_failed" || !strings.Contains(err.Error(), "BADSIG") {
		t.Fatalf("wrong secret: %v", err)
	}
	_, err = provider(t, f, map[string]string{"tsig_key_name": "unknown-key"}).GetRecords(ctx, "example.com.")
	if !errors.Is(err, dnsx.ErrAuth) || !strings.Contains(err.Error(), "BADKEY") {
		t.Fatalf("unknown key: %v", err)
	}
	skewed := provider(t, f, nil)
	skewed.now = func() time.Time { return time.Now().Add(-time.Hour) }
	if _, err = skewed.AppendRecords(ctx, "example.com.", add); !errors.Is(err, dnsx.ErrAuth) || !strings.Contains(err.Error(), "BADTIME") {
		t.Fatalf("clock skew: %v", err)
	}

	p := provider(t, f, nil)
	f.answer(dns.RcodeRefused, false)
	if _, err = p.AppendRecords(ctx, "example.com.", add); !errors.Is(err, dnsx.ErrAuth) || !strings.Contains(err.Error(), "update REFUSED") {
		t.Fatalf("update refused: %v", err)
	}
	if _, err = p.GetRecords(ctx, "example.com."); !errors.Is(err, dnsx.ErrAuth) || !strings.Contains(err.Error(), "allow AXFR") {
		t.Fatalf("transfer refused: %v", err)
	}
	f.answer(dns.RcodeNotAuth, false)
	if _, err = p.SetRecords(ctx, "example.org.", add); !errors.Is(err, dnsx.ErrZoneNotFound) {
		t.Fatalf("unknown zone: %v", err)
	}
	f.answer(dns.RcodeServerFailure, false)
	if _, err = p.DeleteRecords(ctx, "example.com.", add); dnsx.Code(err) != "dns_provider_unreachable" {
		t.Fatalf("servfail: %v", err)
	}
	f.answer(dns.RcodeSuccess, true)
	_, err = p.AppendRecords(ctx, "example.com.", add)
	dnstest.NoSecret(t, err, secret)
	if !errors.Is(err, dnsx.ErrAuth) || !strings.Contains(err.Error(), "unsigned") {
		t.Fatalf("unsigned answer accepted: %v", err)
	}
	f.mu.Lock()
	f.unsigned, f.forged = false, true
	f.mu.Unlock()
	_, err = p.AppendRecords(ctx, "example.com.", add)
	dnstest.NoSecret(t, err, secret, other)
	if !errors.Is(err, dnsx.ErrAuth) || !strings.Contains(err.Error(), "does not verify") {
		t.Fatalf("forged answer accepted: %v", err)
	}
	if _, err = p.AppendRecords(ctx, "example.com.", []libdns.Record{dnstest.A("www", "not-an-ip", 60)}); !errors.Is(err, dnsx.ErrInvalid) {
		t.Fatalf("bad data: %v", err)
	}
	if _, err = p.AppendRecords(ctx, "example.com.", []libdns.Record{dnstest.A("www.example.org.", "192.0.2.1", 60)}); !errors.Is(err, dnsx.ErrInvalid) {
		t.Fatalf("out-of-zone name: %v", err)
	}
}

func TestPolicyRefusesLoopback(t *testing.T) {
	f := serve(t)
	p, err := New(map[string]string{"server": f.addr, "tsig_key_name": keyName, "tsig_secret": secret}, dnsx.Options{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.AppendRecords(context.Background(), "example.com.", []libdns.Record{dnstest.TXT("_acme-challenge", "x", 60)})
	dnstest.NoSecret(t, err, secret)
	if !errors.Is(err, dnsx.ErrRefused) || dnsx.Code(err) != "dns_address_refused" {
		t.Fatalf("loopback without allow list: %v", err)
	}
	if _, err = p.GetRecords(context.Background(), "example.com."); !errors.Is(err, dnsx.ErrRefused) {
		t.Fatalf("transfer: %v", err)
	}
	if n := f.received(); n != 0 {
		t.Fatalf("server was reached: %d messages", n)
	}
}

func TestCanceledContext(t *testing.T) {
	f := serve(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := provider(t, f, nil).GetRecords(ctx, "example.com."); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled: %v", err)
	}
}

func TestNewRejectsMalformedFields(t *testing.T) {
	good := map[string]string{"server": "ns1.example.net", "tsig_key_name": "edgeweir-key", "tsig_secret": secret}
	for _, bad := range []map[string]string{
		{"server": ""},
		{"server": "ns1.example.net:0"},
		{"server": "ns1.example.net:65536"},
		{"server": "ns1 example.net"},
		{"server": "[fe80::1%en0]:53"},
		{"server": "https://ns1.example.net"},
		{"tsig_key_name": ""},
		{"tsig_key_name": "two words"},
		{"tsig_algorithm": "hmac-md5"},
		{"tsig_secret": ""},
		{"tsig_secret": "not base64!"},
	} {
		fields := map[string]string{}
		for k, v := range good {
			fields[k] = v
		}
		for k, v := range bad {
			fields[k] = v
		}
		_, err := New(fields, dnsx.Options{})
		if !errors.Is(err, dnsx.ErrInvalid) {
			t.Errorf("%v accepted: %v", bad, err)
		} else {
			dnstest.NoSecret(t, err, secret, "not base64!")
		}
	}
	for in, want := range map[string]string{
		"ns1.example.net":       "ns1.example.net:53",
		"ns1.example.net.:5353": "ns1.example.net:5353",
		"192.0.2.53":            "192.0.2.53:53",
		"192.0.2.53:5353":       "192.0.2.53:5353",
		"2001:db8::53":          "[2001:db8::53]:53",
		"[2001:db8::53]":        "[2001:db8::53]:53",
		"[2001:db8::53]:5353":   "[2001:db8::53]:5353",
	} {
		if got, err := serverAddress(in); err != nil || got != want {
			t.Errorf("serverAddress(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}

func TestTXTWireRoundTrip(t *testing.T) {
	long := strings.Repeat("a", 256)
	for _, text := range []string{"", `a "b" \c`, "café", long, "line\nbreak\x7f"} {
		rr := &dns.TXT{Hdr: dns.RR_Header{Name: "example.com.", Rrtype: dns.TypeTXT, Class: dns.ClassINET}, Txt: txtStrings(text)}
		buf := make([]byte, 4096)
		n, err := dns.PackRR(rr, buf, 0, nil, false)
		if err != nil {
			t.Fatal(err)
		}
		back, _, err := dns.UnpackRR(buf[:n], 0)
		if err != nil {
			t.Fatal(err)
		}
		if got := joinTXT(back.(*dns.TXT).Txt); got != text {
			t.Errorf("round trip %q -> %q", text, got)
		}
	}
	if parts := txtStrings(strings.Repeat("a", 256)); len(parts) != 2 || len(parts[0]) != 255 {
		t.Errorf("split: %v", parts)
	}
}
