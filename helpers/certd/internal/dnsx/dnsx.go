// Package dnsx holds what every DNS provider adapter of edgeweir-certd
// shares: the provider interface (libdns v1), the options the console passes
// with each request, bounded HTTP clients, error classification and record
// helpers.
//
// Record conventions (libdns v1): zones are FQDNs with a trailing dot
// ("example.com."), record names are relative to the zone ("www", "@" for
// the apex), TTLs are durations, TXT data is unquoted, CNAME data is a
// hostname. SetRecords replaces every (name, type) RRset in its input;
// DeleteRecords deletes records matching name, type and (when not empty) data.
// Adapters of providers with resolution lines (lines.go) read the line of
// each record: SetRecords replaces an input (name, type) on every line,
// DeleteRecords matches the input's line; the other adapters only receive
// default-line records.
package dnsx

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/libdns/libdns"
)

// Provider is what the console needs from a DNS provider.
type Provider interface {
	libdns.RecordGetter
	libdns.RecordAppender
	libdns.RecordSetter
	libdns.RecordDeleter
}

// Options are per-request settings from the console. They never contain
// credentials.
type Options struct {
	// AllowCIDRs are the operator's outbound allow list
	// (EDGEWEIR_OUTBOUND_ALLOW_CIDRS). Adapters that connect to an address
	// the user configured (PowerDNS, RFC 2136, webhook) refuse
	// special-purpose addresses outside this list.
	AllowCIDRs []netip.Prefix
	// BaseURL replaces a fixed API endpoint. Only tests set it.
	BaseURL string
	// HTTPClient replaces the adapter's client. Only tests set it.
	HTTPClient *http.Client
}

// Factory builds a provider from validated credential fields.
type Factory func(fields map[string]string, opts Options) (Provider, error)

// Endpoint returns the test override or the fixed endpoint.
func (o Options) Endpoint(fixed string) string {
	if o.BaseURL != "" {
		return strings.TrimRight(o.BaseURL, "/")
	}
	return fixed
}

// Client returns the client for a fixed provider endpoint: 30 s per
// request, no redirects (an API that redirects would receive credentials
// at a second host).
func (o Options) Client() *http.Client {
	if o.HTTPClient != nil {
		return o.HTTPClient
	}
	return &http.Client{Timeout: 30 * time.Second, CheckRedirect: noRedirect}
}

func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// Error kinds the console maps to its own error codes. Adapters wrap them
// (fmt.Errorf("...: %w", dnsx.ErrAuth)); messages never contain credentials.
var (
	ErrAuth         = errors.New("dns_auth_failed")
	ErrZoneNotFound = errors.New("dns_zone_not_found")
	ErrRefused      = errors.New("dns_address_refused")
	ErrUnreachable  = errors.New("dns_provider_unreachable")
	ErrRateLimited  = errors.New("dns_rate_limited")
	ErrUnsupported  = errors.New("dns_unsupported")
	ErrInvalid      = errors.New("dns_invalid_request")
	ErrProvider     = errors.New("dns_provider_error")
)

var kinds = []error{ErrAuth, ErrZoneNotFound, ErrRefused, ErrUnreachable, ErrRateLimited, ErrUnsupported, ErrInvalid, ErrProvider}

// Code classifies an adapter error for the console.
func Code(err error) string {
	if code, ok := Kind(err); ok {
		return code
	}
	var timeout interface{ Timeout() bool }
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &timeout) && timeout.Timeout()) {
		return ErrUnreachable.Error()
	}
	return ErrProvider.Error()
}

// Kind returns the kind an adapter attached to err (an error kind or a
// StatusError), without Code's fallbacks: an error that carries none is not
// known to be a DNS failure.
func Kind(err error) (string, bool) {
	for _, kind := range kinds {
		if errors.Is(err, kind) {
			return kind.Error(), true
		}
	}
	var status *StatusError
	if errors.As(err, &status) {
		return status.Kind().Error(), true
	}
	return "", false
}

// StatusError is a non-success HTTP answer. Message is the provider's own
// short error text or code (never the request).
type StatusError struct {
	Status  int
	Message string
}

func (e *StatusError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("HTTP %d", e.Status)
	}
	return fmt.Sprintf("HTTP %d: %s", e.Status, e.Message)
}

// Kind maps an HTTP status to an error kind.
func (e *StatusError) Kind() error {
	switch {
	case e.Status == http.StatusUnauthorized || e.Status == http.StatusForbidden:
		return ErrAuth
	case e.Status == http.StatusNotFound:
		return ErrZoneNotFound
	case e.Status == http.StatusTooManyRequests:
		return ErrRateLimited
	case e.Status >= 500:
		return ErrUnreachable
	default:
		return ErrProvider
	}
}

func (e *StatusError) Unwrap() error { return e.Kind() }

// Short trims provider text used in error messages.
func Short(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > 200 {
		return text[:200]
	}
	return text
}

// Zone returns the zone without its trailing dot ("example.com").
func Zone(zone string) string { return strings.TrimSuffix(strings.ToLower(zone), ".") }

// FQDN returns the absolute name of a relative record name, without the
// trailing dot ("www" in "example.com." -> "www.example.com").
func FQDN(name, zone string) string {
	return strings.TrimSuffix(libdns.AbsoluteName(name, zone), ".")
}

// Relative turns a provider's absolute or relative name into a libdns
// relative name ("@" for the apex).
func Relative(name, zone string) string {
	name = strings.TrimSuffix(strings.ToLower(name), ".")
	z := Zone(zone)
	switch {
	case name == "" || name == "@" || name == z:
		return "@"
	case strings.HasSuffix(name, "."+z):
		return strings.TrimSuffix(name, "."+z)
	default:
		return name
	}
}

// Host normalizes a name the provider already returns relative to the zone
// ("www", "@", ""): lower case, no trailing dot, "@" for the apex. Unlike
// Relative it never strips the zone, so a record literally named
// "www.example.com" inside example.com stays distinct from "www".
func Host(name string) string {
	name = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(name)), ".")
	if name == "" {
		return "@"
	}
	return name
}

// Name reads a record name from a provider that stores names relative to
// the zone: a name ending in "." is absolute (zone-file convention) and is
// made relative; any other name is kept as it is (Host).
func Name(name, zone string) string {
	if strings.HasSuffix(strings.TrimSpace(name), ".") {
		return Relative(name, zone)
	}
	return Host(name)
}

// Seconds converts a libdns TTL to whole seconds (at least 1).
func Seconds(ttl time.Duration) int {
	if s := int(ttl / time.Second); s > 0 {
		return s
	}
	return 1
}

// RR builds a record in the output form the console expects.
func RR(name, typ, data string, ttlSeconds int) libdns.RR {
	return libdns.RR{Name: name, Type: strings.ToUpper(typ), Data: data, TTL: time.Duration(ttlSeconds) * time.Second}
}

// Key identifies an RRset member (name, type, data).
func Key(r libdns.RR) string {
	return strings.ToLower(r.Name) + "\x00" + strings.ToUpper(r.Type) + "\x00" + CanonicalData(r.Type, r.Data)
}

// SetKey identifies an RRset (name, type).
func SetKey(r libdns.RR) string { return strings.ToLower(r.Name) + "\x00" + strings.ToUpper(r.Type) }

// CanonicalData compares record data the way DNS does: hostnames are
// case-insensitive and may carry a trailing dot; TXT may arrive quoted.
func CanonicalData(typ, data string) string {
	switch strings.ToUpper(typ) {
	case "CNAME", "NS", "ALIAS":
		return strings.TrimSuffix(strings.ToLower(data), ".")
	case "TXT":
		return Unquote(data)
	case "A", "AAAA":
		if ip, err := netip.ParseAddr(data); err == nil {
			return ip.String()
		}
	}
	return data
}

// Unquote removes the quotes of a TXT value in zone-file form ("a" "b" -> ab).
func Unquote(value string) string {
	value = strings.TrimSpace(value)
	if len(value) < 2 || value[0] != '"' {
		return value
	}
	var out strings.Builder
	quoted, escaped := false, false
	for _, c := range value {
		switch {
		case escaped:
			out.WriteRune(c)
			escaped = false
		case c == '\\' && quoted:
			escaped = true
		case c == '"':
			quoted = !quoted
		case quoted:
			out.WriteRune(c)
		}
	}
	return out.String()
}

// Matches reports whether an existing record is selected by a delete input:
// name and type must match, data only when the input has data.
func Matches(existing, input libdns.RR) bool {
	if !strings.EqualFold(existing.Name, input.Name) || !strings.EqualFold(existing.Type, input.Type) {
		return false
	}
	return input.Data == "" || CanonicalData(existing.Type, existing.Data) == CanonicalData(input.Type, input.Data)
}

// RRs converts libdns records to RR values.
func RRs(records []libdns.Record) []libdns.RR {
	out := make([]libdns.RR, 0, len(records))
	for _, r := range records {
		out = append(out, r.RR())
	}
	return out
}

// Records converts RR values back to libdns records.
func Records(rrs []libdns.RR) []libdns.Record {
	out := make([]libdns.Record, 0, len(rrs))
	for _, r := range rrs {
		out = append(out, r)
	}
	return out
}
