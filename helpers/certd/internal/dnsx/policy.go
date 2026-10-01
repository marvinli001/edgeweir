package dnsx

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"
)

// SpecialPurpose lists the ranges the console's outbound policy refuses
// unless the operator allows them. It must stay equal to
// SPECIAL_PURPOSE_IPV4 and SPECIAL_PURPOSE_IPV6 in
// packages/contract/src/addresses.ts (a console test compares them).
var SpecialPurpose = []string{
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
	"::/128",
	"::1/128",
	"100::/64",
	"2001:db8::/32",
	"fc00::/7",
	"fe80::/10",
	"ff00::/8",
}

var special = func() []netip.Prefix {
	out := make([]netip.Prefix, 0, len(SpecialPurpose))
	for _, text := range SpecialPurpose {
		out = append(out, netip.MustParsePrefix(text))
	}
	return out
}()

var embedding = []netip.Prefix{netip.MustParsePrefix("::ffff:0:0/96"), netip.MustParsePrefix("64:ff9b::/96")}

// judged returns the address the policy looks at: the IPv4 address inside
// an IPv4-mapped or NAT64 address, the address itself otherwise.
func judged(ip netip.Addr) netip.Addr {
	ip = ip.WithZone("")
	if ip.Is6() {
		for _, p := range embedding {
			if p.Contains(ip) {
				b := ip.As16()
				return netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]})
			}
		}
	}
	return ip
}

// IsSpecial reports whether an address falls in a special-purpose range.
func IsSpecial(ip netip.Addr) bool {
	ip = judged(ip)
	for _, p := range special {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// Allowed reports whether the policy lets a connection reach ip: public
// addresses always, special-purpose ones only inside the allow list.
func Allowed(ip netip.Addr, allow []netip.Prefix) bool {
	if !IsSpecial(ip) {
		return true
	}
	ip = judged(ip)
	for _, p := range allow {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// PolicyDialer connects only to addresses the policy allows. The check runs
// on the socket's actual peer address, so a name that resolves to another
// address later (DNS rebinding) is still judged by what it connects to.
// With cleartext set, only allowed special-purpose (LAN) addresses pass:
// credentials never travel unencrypted over the public Internet.
func PolicyDialer(allow []netip.Prefix, cleartext bool) *net.Dialer {
	return &net.Dialer{
		Timeout: 10 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil {
				return fmt.Errorf("%w: unparsable peer", ErrRefused)
			}
			ip := ap.Addr()
			if !Allowed(ip, allow) {
				return fmt.Errorf("%w: special-purpose address", ErrRefused)
			}
			if cleartext && !IsSpecial(ip) {
				return fmt.Errorf("%w: HTTPS required for public destinations", ErrRefused)
			}
			return nil
		},
	}
}

// PolicyClient is the HTTP client for an endpoint the user configured: every
// connection goes through PolicyDialer (cleartext HTTP only to allowed LAN
// addresses), no proxy, no redirects, 30 s per request.
func (o Options) PolicyClient() *http.Client {
	if o.HTTPClient != nil {
		return o.HTTPClient
	}
	transport := func(cleartext bool) *http.Transport {
		return &http.Transport{
			Proxy:                 nil,
			DialContext:           PolicyDialer(o.AllowCIDRs, cleartext).DialContext,
			ForceAttemptHTTP2:     true,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 20 * time.Second,
			MaxIdleConns:          4,
			IdleConnTimeout:       30 * time.Second,
		}
	}
	return &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: noRedirect,
		Transport:     schemeTransport{https: transport(false), http: transport(true)},
	}
}

type schemeTransport struct{ https, http http.RoundTripper }

func (t schemeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	switch req.URL.Scheme {
	case "https":
		return t.https.RoundTrip(req)
	case "http":
		return t.http.RoundTrip(req)
	default:
		return nil, fmt.Errorf("%w: unsupported URL scheme", ErrRefused)
	}
}

// DialPolicy dials a non-HTTP endpoint (RFC 2136) under the policy.
func DialPolicy(ctx context.Context, allow []netip.Prefix, network, address string) (net.Conn, error) {
	return PolicyDialer(allow, false).DialContext(ctx, network, address)
}
