// Package dnstest replays recorded provider API exchanges for adapter unit
// tests. A cassette is the ordered list of requests an operation must send
// and the answers the provider gives (built from the provider's official API
// reference). The server fails the test on any request that does not match
// the next exchange, and at cleanup when exchanges remain unused.
package dnstest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/libdns/libdns"
)

// Exchange is one recorded request and its answer. Empty match fields are
// not checked; Query, Header and Form must contain the given values
// (subset); JSON must be a subset of the request's JSON body.
type Exchange struct {
	Method string
	// Path is the unescaped URL path ("/client/v4/zones/abc/dns_records").
	Path   string
	Host   string            // original host (RewriteDefaultTransport only)
	Query  map[string]string // "" means the key must be absent
	Header map[string]string // "*" means present with any value
	Form   map[string]string // application/x-www-form-urlencoded body fields
	JSON   any               // JSON body subset (maps, slices, strings, numbers, bools)
	// Body matches the raw body exactly when set.
	Body string
	// Check runs custom assertions on the request and its body.
	Check func(t *testing.T, r *http.Request, body []byte)

	Status         int // default 200
	Response       string
	ResponseHeader map[string]string
}

// Server replays a cassette.
type Server struct {
	*httptest.Server
	t         *testing.T
	mu        sync.Mutex
	exchanges []Exchange
	next      int
	// Requests records every request body (for extra assertions).
	Requests []Recorded
}

// Recorded is a request the server received.
type Recorded struct {
	Method, Host, Path string
	Query              url.Values
	Header             http.Header
	Body               []byte
}

// Serve starts a server for the cassette.
func Serve(t *testing.T, exchanges ...Exchange) *Server {
	t.Helper()
	s := &Server{t: t, exchanges: exchanges}
	s.Server = httptest.NewServer(http.HandlerFunc(s.handle))
	t.Cleanup(func() {
		s.Close()
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.next != len(s.exchanges) {
			t.Errorf("dnstest: %d of %d recorded exchanges were not requested; next: %s %s", len(s.exchanges)-s.next, len(s.exchanges), s.exchanges[s.next].Method, s.exchanges[s.next].Path)
		}
	})
	return s
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	host := r.Header.Get("X-Dnstest-Host")
	r.Header.Del("X-Dnstest-Host")
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Requests = append(s.Requests, Recorded{Method: r.Method, Host: host, Path: r.URL.Path, Query: r.URL.Query(), Header: r.Header.Clone(), Body: body})
	if s.next >= len(s.exchanges) {
		s.t.Errorf("dnstest: unexpected request %s %s (cassette exhausted)", r.Method, r.URL.Path)
		http.Error(w, `{"error":"unexpected request"}`, http.StatusTeapot)
		return
	}
	e := s.exchanges[s.next]
	s.next++
	if problems := match(e, r, host, body); len(problems) > 0 {
		s.t.Errorf("dnstest: request %d (%s %s) does not match the recording:\n  %s\n  body: %s", s.next, r.Method, r.URL.Path, strings.Join(problems, "\n  "), truncate(body))
	}
	if e.Check != nil {
		e.Check(s.t, r, body)
	}
	for k, v := range e.ResponseHeader {
		w.Header().Set(k, v)
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json")
	}
	status := e.Status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, e.Response)
}

func truncate(b []byte) string {
	if len(b) > 600 {
		return string(b[:600]) + "…"
	}
	return string(b)
}

func match(e Exchange, r *http.Request, host string, body []byte) []string {
	var problems []string
	if e.Method != "" && e.Method != r.Method {
		problems = append(problems, fmt.Sprintf("method %s, want %s", r.Method, e.Method))
	}
	if e.Path != "" && e.Path != r.URL.Path {
		problems = append(problems, fmt.Sprintf("path %s, want %s", r.URL.Path, e.Path))
	}
	if e.Host != "" && e.Host != host {
		problems = append(problems, fmt.Sprintf("host %q, want %q", host, e.Host))
	}
	q := r.URL.Query()
	for _, k := range sortedKeys(e.Query) {
		want := e.Query[k]
		if want == "" {
			if q.Has(k) {
				problems = append(problems, fmt.Sprintf("query %s present, want absent", k))
			}
		} else if q.Get(k) != want {
			problems = append(problems, fmt.Sprintf("query %s=%q, want %q", k, q.Get(k), want))
		}
	}
	for _, k := range sortedKeys(e.Header) {
		want := e.Header[k]
		got := r.Header.Get(k)
		if (want == "*" && got == "") || (want != "*" && got != want) {
			problems = append(problems, fmt.Sprintf("header %s=%q, want %q", k, got, want))
		}
	}
	if len(e.Form) > 0 {
		form, err := url.ParseQuery(string(body))
		if err != nil {
			problems = append(problems, "body is not form-encoded")
		}
		for _, k := range sortedKeys(e.Form) {
			if form.Get(k) != e.Form[k] {
				problems = append(problems, fmt.Sprintf("form %s=%q, want %q", k, form.Get(k), e.Form[k]))
			}
		}
	}
	if e.JSON != nil {
		var got any
		if err := json.Unmarshal(body, &got); err != nil {
			problems = append(problems, "body is not JSON")
		} else if err := subset(normalize(e.JSON), got, "$"); err != "" {
			problems = append(problems, err)
		}
	}
	if e.Body != "" && e.Body != string(body) {
		problems = append(problems, fmt.Sprintf("body %q, want %q", truncate(body), e.Body))
	}
	return problems
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// normalize turns Go literals into what json.Unmarshal produces.
func normalize(v any) any {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var out any
	_ = json.Unmarshal(raw, &out)
	return out
}

// subset checks that want is contained in got: objects by key (recursively),
// arrays element by element with equal length, scalars by equality.
func subset(want, got any, path string) string {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return fmt.Sprintf("%s is %T, want object", path, got)
		}
		for _, k := range sortedMapKeys(w) {
			gv, present := g[k]
			if !present {
				return fmt.Sprintf("%s.%s missing", path, k)
			}
			if p := subset(w[k], gv, path+"."+k); p != "" {
				return p
			}
		}
		return ""
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return fmt.Sprintf("%s = %v, want %d elements", path, got, len(w))
		}
		for i := range w {
			if p := subset(w[i], g[i], fmt.Sprintf("%s[%d]", path, i)); p != "" {
				return p
			}
		}
		return ""
	default:
		if !reflect.DeepEqual(want, got) {
			return fmt.Sprintf("%s = %v, want %v", path, got, want)
		}
		return ""
	}
}

func sortedMapKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// RewriteDefaultTransport sends every request made through
// http.DefaultTransport (third-party libdns modules use http.DefaultClient
// or a client without a transport) to the server, keeping the original host
// for Exchange.Host checks. Only hosts in allowedHosts may be contacted.
// Tests using it must not run in parallel.
func (s *Server) RewriteDefaultTransport(t *testing.T, allowedHosts ...string) {
	t.Helper()
	target, _ := url.Parse(s.URL)
	previous := http.DefaultTransport
	base := &http.Transport{}
	http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		allowed := false
		for _, h := range allowedHosts {
			if r.URL.Hostname() == h {
				allowed = true
			}
		}
		if !allowed {
			t.Errorf("dnstest: request to unexpected host %q", r.URL.Host)
			return nil, fmt.Errorf("unexpected host")
		}
		clone := r.Clone(r.Context())
		clone.Header.Set("X-Dnstest-Host", r.URL.Hostname())
		clone.URL.Scheme = target.Scheme
		clone.URL.Host = target.Host
		clone.Host = target.Host
		if r.Body != nil {
			raw, _ := io.ReadAll(r.Body)
			clone.Body = io.NopCloser(bytes.NewReader(raw))
		}
		return base.RoundTrip(clone)
	})
	t.Cleanup(func() { http.DefaultTransport = previous })
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// A builds an A record input.
func A(name, ip string, ttl int) libdns.Record {
	return libdns.RR{Name: name, Type: "A", Data: ip, TTL: time.Duration(ttl) * time.Second}
}

// AAAA builds an AAAA record input.
func AAAA(name, ip string, ttl int) libdns.Record {
	return libdns.RR{Name: name, Type: "AAAA", Data: ip, TTL: time.Duration(ttl) * time.Second}
}

// CNAME builds a CNAME record input.
func CNAME(name, target string, ttl int) libdns.Record {
	return libdns.RR{Name: name, Type: "CNAME", Data: target, TTL: time.Duration(ttl) * time.Second}
}

// TXT builds a TXT record input.
func TXT(name, text string, ttl int) libdns.Record {
	return libdns.RR{Name: name, Type: "TXT", Data: text, TTL: time.Duration(ttl) * time.Second}
}

// Has reports whether records contain name/type/data (data compared the DNS
// way: case-insensitive hostnames without trailing dots, unquoted TXT).
func Has(records []libdns.Record, name, typ, data string) bool {
	for _, r := range records {
		rr := r.RR()
		if strings.EqualFold(rr.Name, name) && strings.EqualFold(rr.Type, typ) && canonical(typ, rr.Data) == canonical(typ, data) {
			return true
		}
	}
	return false
}

func canonical(typ, data string) string {
	switch strings.ToUpper(typ) {
	case "CNAME":
		return strings.TrimSuffix(strings.ToLower(data), ".")
	case "TXT":
		return strings.Trim(data, `"`)
	}
	return data
}

// NoSecret fails when an error message contains any of the secrets.
func NoSecret(t *testing.T, err error, secrets ...string) {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, secret := range secrets {
		if secret != "" && strings.Contains(err.Error(), secret) {
			t.Fatalf("error message leaks a credential: %v", err)
		}
	}
}
