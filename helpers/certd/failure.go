package main

import (
	"errors"
	"net"
	"net/url"
	"strings"

	"github.com/go-acme/lego/v4/acme"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// codedError is a failure certd classifies itself (Response.Code).
type codedError struct {
	code string
	err  error
}

func (e *codedError) Error() string { return e.err.Error() }
func (e *codedError) Unwrap() error { return e.err }

func coded(code string, err error) error { return &codedError{code: code, err: err} }

// dnsProviderError is a failure of the DNS provider during a DNS-01
// challenge: it is classified like a dns.* command, whatever the adapter
// attached to it.
type dnsProviderError struct{ err error }

func (e *dnsProviderError) Error() string { return e.err.Error() }
func (e *dnsProviderError) Unwrap() error { return e.err }

// acmeProblems maps ACME problem types (RFC 8555 §6.7) to the codes the
// console shows, most specific first: of several problems (one per name,
// subproblems), the first in this list names the failure.
var acmeProblems = []struct{ problem, code string }{
	{"externalAccountRequired", "acme_external_account_required"},
	{"unauthorized", "acme_unauthorized"},
	{"caa", "acme_caa"},
	{"dns", "acme_dns"},
	{"connection", "acme_connection"},
	{"tls", "acme_tls"},
	{"incorrectResponse", "acme_incorrect_response"},
	{"rejectedIdentifier", "acme_rejected_identifier"},
	{"unsupportedIdentifier", "acme_unsupported_identifier"},
	{"rateLimited", "acme_rate_limited"},
	{"badCSR", "acme_bad_csr"},
	{"invalidContact", "acme_invalid_contact"},
	{"unsupportedContact", "acme_unsupported_contact"},
	{"userActionRequired", "acme_user_action_required"},
	{"accountDoesNotExist", "acme_account_does_not_exist"},
	{"orderNotReady", "acme_order_not_ready"},
	{"malformed", "acme_malformed"},
	{"serverInternal", "acme_server_internal"},
}

// walkErrors calls visit for err and every error it wraps (errors.Join and
// lego's per-domain errors wrap several).
func walkErrors(err error, visit func(error)) {
	if err == nil {
		return
	}
	visit(err)
	switch e := err.(type) {
	case interface{ Unwrap() error }:
		walkErrors(e.Unwrap(), visit)
	case interface{ Unwrap() []error }:
		for _, inner := range e.Unwrap() {
			walkErrors(inner, visit)
		}
	}
}

// problemCode is the code of the ACME problems in err: the most specific
// known type of all problems and subproblems, "acme_error" for problems of
// other types, "" without problems.
func problemCode(err error) string {
	found := false
	best := len(acmeProblems)
	rank := func(problemType string) {
		name := strings.TrimPrefix(problemType, "urn:ietf:params:acme:error:")
		for i, p := range acmeProblems {
			if p.problem == name && i < best {
				best = i
			}
		}
	}
	walkErrors(err, func(e error) {
		problem, ok := e.(*acme.ProblemDetails)
		if !ok || problem == nil {
			return
		}
		found = true
		rank(problem.Type)
		for _, sub := range problem.SubProblems {
			rank(sub.Type)
		}
	})
	switch {
	case best < len(acmeProblems):
		return acmeProblems[best].code
	case found:
		return "acme_error"
	default:
		return ""
	}
}

// failureCode classifies a failed obtain, renew or revoke for the console,
// which stores the code as the certificate's last error and shows it in
// the operator's language. The CA's and the provider's text never leaves
// certd this way (it may quote names, account URLs or provider details).
func failureCode(err error) string {
	var provider *dnsProviderError
	if errors.As(err, &provider) {
		return dnsx.Code(provider.err)
	}
	if code, ok := dnsx.Kind(err); ok {
		return code
	}
	if code := problemCode(err); code != "" {
		return code
	}
	var c *codedError
	if errors.As(err, &c) {
		return c.code
	}
	// lego's own waits end with plain errors (platform/wait, the DNS-01
	// validation backoff); a test pins their wording.
	text := err.Error()
	switch {
	case strings.Contains(text, "propagation: time limit exceeded"):
		return "dns_propagation_timeout"
	case strings.Contains(text, "certificate: time limit exceeded"):
		return "acme_order_timeout"
	case strings.Contains(text, "the server didn't respond to our request"):
		return "acme_validation_timeout"
	}
	var urlErr *url.Error
	var netErr net.Error
	if errors.As(err, &urlErr) || errors.As(err, &netErr) {
		return "acme_unreachable"
	}
	return "certd_failed"
}
