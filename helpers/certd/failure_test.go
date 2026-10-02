package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"testing"
	"time"

	"github.com/go-acme/lego/v4/acme"
	"github.com/go-acme/lego/v4/platform/wait"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

func problem(kind string, subs ...string) *acme.ProblemDetails {
	p := &acme.ProblemDetails{Type: "urn:ietf:params:acme:error:" + kind, Detail: "detail for ops@example.com", HTTPStatus: 403}
	for _, sub := range subs {
		p.SubProblems = append(p.SubProblems, acme.SubProblem{Type: "urn:ietf:params:acme:error:" + sub})
	}
	return p
}

func TestFailureCodes(t *testing.T) {
	// lego hands the rate limit out as an error value.
	var rateLimited error = &acme.RateLimitedError{ProblemDetails: problem("rateLimited")}
	propagation := wait.For("propagation", time.Millisecond, time.Millisecond, func() (bool, error) { return false, nil })
	finalize := wait.For("certificate", time.Millisecond, time.Millisecond, func() (bool, error) {
		return false, errors.New("not yet")
	})
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"ACME problem", fmt.Errorf("ACME issuance failed: %w", problem("unauthorized")), "acme_unauthorized"},
		{"rate limit", fmt.Errorf("ACME issuance failed: %w", rateLimited), "acme_rate_limited"},
		{"EAB required at registration", fmt.Errorf("ACME registration failed: %w", problem("externalAccountRequired")), "acme_external_account_required"},
		{"subproblem of a compound problem", problem("compound", "caa"), "acme_caa"},
		{"most specific of several names", fmt.Errorf("error: %w", errors.Join(
			fmt.Errorf("a.test: %w", problem("serverInternal")),
			fmt.Errorf("b.test: invalid authorization: %w", problem("dns")),
		)), "acme_dns"},
		{"problem type unknown to the console", problem("somethingNew"), "acme_error"},
		{"HTTP-01 validation timeout", fmt.Errorf("[a.test] %w", errValidationTimeout), "acme_validation_timeout"},
		{"DNS-01 validation timeout", errors.New("the server didn't respond to our request (status=pending)"), "acme_validation_timeout"},
		{"DNS-01 propagation timeout", fmt.Errorf("[a.test] %w", propagation), "dns_propagation_timeout"},
		{"order not issued in time", finalize, "acme_order_timeout"},
		{"DNS provider refused the credentials", &dnsProviderError{fmt.Errorf("records: %w", dnsx.ErrAuth)}, "dns_auth_failed"},
		{"DNS provider status", fmt.Errorf("[a.test] acme: error presenting token: %w", &dnsProviderError{&dnsx.StatusError{Status: 404}}), "dns_zone_not_found"},
		{"unclassified DNS provider error", &dnsProviderError{errors.New("odd")}, "dns_provider_error"},
		{"DNS provider timeout", &dnsProviderError{context.DeadlineExceeded}, "dns_provider_unreachable"},
		{"name outside the credential's zone", fmt.Errorf("[a.test] %w", coded("dns_zone_mismatch", errors.New("outside"))), "dns_zone_mismatch"},
		{"directory unreachable", coded("acme_directory_unreachable", fmt.Errorf("get directory: %w", &url.Error{Op: "Get", URL: "https://ca.test/dir", Err: errors.New("refused")})), "acme_directory_unreachable"},
		{"CA unreachable later", fmt.Errorf("ACME issuance failed: %w", &url.Error{Op: "Post", URL: "https://ca.test/order", Err: &net.OpError{Op: "dial", Err: errors.New("refused")}}), "acme_unreachable"},
		// Not a DNS failure just because nothing else matched.
		{"anything else", errors.New("CA returned invalid certificate"), "certd_failed"},
	}
	for _, c := range cases {
		if got := failureCode(c.err); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

// Every code fits the console's pattern (certificate-worker.ts runCertd).
func TestFailureCodesFitTheConsole(t *testing.T) {
	pattern := regexp.MustCompile(`^[a-z0-9_]{1,40}$`)
	codes := []string{"acme_error", "acme_validation_timeout", "acme_order_timeout", "acme_unreachable", "acme_directory_invalid", "acme_directory_unreachable", "acme_ca_file_invalid", "dns_propagation_timeout", "dns_zone_mismatch", "certd_failed"}
	for _, p := range acmeProblems {
		codes = append(codes, p.code)
	}
	for _, code := range codes {
		if !pattern.MatchString(code) {
			t.Errorf("code %q does not fit the console", code)
		}
	}
}

func TestObtainFailuresCarryACode(t *testing.T) {
	resp, _ := call(t, `{"command":"obtain","params":{"email":"a@b.test","domains":["a.test"],"directoryUrl":"http://ca.test/dir","challenge":"http01","account":{}}}`)
	if resp.OK || resp.Code != "acme_directory_invalid" {
		t.Fatalf("got %+v", resp)
	}
	// renewal-info failures stay unclassified: the console only logs them.
	resp, _ = call(t, `{"command":"renewal-info","params":{"directoryUrl":"http://ca.test/dir","certificates":["x"]}}`)
	if resp.OK || resp.Code != "" {
		t.Fatalf("got %+v", resp)
	}
}
