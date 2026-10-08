package main

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/go-acme/lego/v4/acme"
	"github.com/go-acme/lego/v4/acme/api"
	"github.com/go-acme/lego/v4/certcrypto"
	"github.com/go-acme/lego/v4/certificate"
	"github.com/go-acme/lego/v4/lego"
	"github.com/go-acme/lego/v4/registration"
	"github.com/libdns/libdns"
)

type acmeAccount struct {
	PrivateKeyPEM string                 `json:"privateKeyPem"`
	Registration  *registration.Resource `json:"registration,omitempty"`
	EABKid        string                 `json:"eabKid,omitempty"`
	EABHMAC       string                 `json:"eabHmacKey,omitempty"`
}
type acmeParams struct {
	Email               string      `json:"email"`
	Domains             []string    `json:"domains"`
	DirectoryURL        string      `json:"directoryUrl"`
	RootCA              string      `json:"rootCa,omitempty"`
	Challenge           string      `json:"challenge"`
	Account             acmeAccount `json:"account"`
	DNS                 *dnsParams  `json:"dns,omitempty"`
	PreviousCertificate string      `json:"previousCertificate,omitempty"`
	// KeyType of the certificate's key: "ec256" (ECDSA P-256, the default) or
	// "rsa2048". The account key is ECDSA P-256 either way.
	KeyType string `json:"keyType,omitempty"`
}

// certificateKeyType maps the request's key type to lego's.
func certificateKeyType(keyType string) (certcrypto.KeyType, error) {
	switch keyType {
	case "", "ec256":
		return certcrypto.EC256, nil
	case "rsa2048":
		return certcrypto.RSA2048, nil
	}
	return "", fmt.Errorf("unsupported certificate key type")
}

type acmeUser struct {
	email        string
	key          crypto.PrivateKey
	registration *registration.Resource
}

func (u *acmeUser) GetEmail() string                        { return u.email }
func (u *acmeUser) GetPrivateKey() crypto.PrivateKey        { return u.key }
func (u *acmeUser) GetRegistration() *registration.Resource { return u.registration }

type protocolSession struct {
	mu     sync.Mutex
	input  *json.Decoder
	output *json.Encoder
}

func (s *protocolSession) event(value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.output.Encode(value); err != nil {
		return err
	}
	var ack struct {
		OK bool `json:"ok"`
	}
	if err := s.input.Decode(&ack); err != nil {
		return fmt.Errorf("challenge coordinator disconnected")
	}
	if !ack.OK {
		return fmt.Errorf("challenge publication rejected")
	}
	return nil
}

// acmeHTTPClient trusts the system roots plus the operator's ACME CA, if any.
func acmeHTTPClient(rootCA string) (*http.Client, error) {
	roots, err := x509.SystemCertPool()
	if err != nil {
		roots = x509.NewCertPool()
	}
	if rootCA != "" && !roots.AppendCertsFromPEM([]byte(rootCA)) {
		return nil, coded("acme_ca_file_invalid", errors.New("invalid ACME trust certificate"))
	}
	return &http.Client{Timeout: 45 * time.Second, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}}}, nil
}

func acmeCommand(ctx context.Context, command string, raw json.RawMessage, session *protocolSession) (any, error) {
	var p acmeParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid ACME request")
	}
	if len(p.Domains) == 0 || len(p.Domains) > 100 || p.Email == "" {
		return nil, fmt.Errorf("email and 1-100 domains are required")
	}
	keyType, err := certificateKeyType(p.KeyType)
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(p.DirectoryURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return nil, coded("acme_directory_invalid", errors.New("ACME directory must be HTTPS"))
	}
	var key crypto.PrivateKey
	if p.Account.PrivateKeyPEM == "" {
		key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, err
		}
		der, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			return nil, err
		}
		p.Account.PrivateKeyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	} else {
		block, _ := pem.Decode([]byte(p.Account.PrivateKeyPEM))
		if block == nil {
			return nil, fmt.Errorf("invalid ACME account key")
		}
		key, err = x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("invalid ACME account key")
		}
	}
	user := &acmeUser{email: p.Email, key: key, registration: p.Account.Registration}
	config := lego.NewConfig(user)
	config.CADirURL = p.DirectoryURL
	config.UserAgent = "edgeweir-certd/" + Version
	config.Certificate.KeyType = keyType
	config.Certificate.Timeout = 2 * time.Minute
	if config.HTTPClient, err = acmeHTTPClient(p.RootCA); err != nil {
		return nil, err
	}
	client, err := lego.NewClient(config)
	if err != nil {
		return nil, coded("acme_directory_unreachable", fmt.Errorf("ACME directory request failed: %w", err))
	}
	if user.registration == nil {
		if p.Account.EABKid != "" {
			user.registration, err = client.Registration.RegisterWithExternalAccountBinding(registration.RegisterEABOptions{TermsOfServiceAgreed: true, Kid: p.Account.EABKid, HmacEncoded: p.Account.EABHMAC})
		} else {
			user.registration, err = client.Registration.Register(registration.RegisterOptions{TermsOfServiceAgreed: true})
		}
		if err != nil {
			return nil, fmt.Errorf("ACME registration failed: %w", err)
		}
		p.Account.Registration = user.registration
		if err := session.event(map[string]any{"event": "account", "account": p.Account}); err != nil {
			return nil, err
		}
	}
	switch p.Challenge {
	case "http01":
		// All names of the order at once (httpResolver), not lego's solver.
		var core *api.Core
		if core, err = api.New(config.HTTPClient, config.UserAgent, config.CADirURL, user.registration.URI, key); err == nil {
			client.Certificate = certificate.NewCertifier(core, &httpResolver{core: core, session: session}, certificate.CertifierOptions{
				KeyType:             config.Certificate.KeyType,
				Timeout:             config.Certificate.Timeout,
				OverallRequestLimit: config.Certificate.OverallRequestLimit,
				DisableCommonName:   config.Certificate.DisableCommonName,
			})
		}
	case "dns01":
		if p.DNS == nil {
			return nil, fmt.Errorf("DNS-01 credentials are required")
		}
		provider, e := providerFor(*p.DNS)
		if e != nil {
			return nil, &dnsProviderError{e}
		}
		err = client.Challenge.SetDNS01Provider(&dnsChallenge{ctx: ctx, session: session, provider: provider, zone: p.DNS.Zone, installed: map[string][]libdns.Record{}})
	default:
		return nil, fmt.Errorf("unsupported ACME challenge")
	}
	if err != nil {
		return nil, err
	}
	req := certificate.ObtainRequest{Domains: p.Domains, Bundle: true}
	if p.PreviousCertificate != "" {
		block, _ := pem.Decode([]byte(p.PreviousCertificate))
		if block != nil {
			if leaf, e := x509.ParseCertificate(block.Bytes); e == nil {
				req.ReplacesCertID, _ = certificate.MakeARICertID(leaf)
			}
		}
	}
	if command == "revoke" {
		return nil, client.Certificate.Revoke([]byte(p.PreviousCertificate))
	}
	resource, err := client.Certificate.Obtain(req)
	if err != nil && req.ReplacesCertID != "" && newOrderRejected(config.HTTPClient, p.DirectoryURL, err) {
		// "replaces" is only a hint (RFC 9773 §5). lego already retries a 409
		// alreadyReplaced; a CA that cannot match the certificate at all (one
		// from another CA, or Pebble 2.10.1 for serials whose first byte is
		// >= 0x80) must not block the renewal either.
		req.ReplacesCertID = ""
		resource, err = client.Certificate.Obtain(req)
	}
	if err != nil {
		return nil, fmt.Errorf("ACME issuance failed: %w", err)
	}
	block, _ := pem.Decode(resource.Certificate)
	if block == nil {
		return nil, fmt.Errorf("CA returned invalid certificate")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, err
	}
	renewAt := leaf.NotBefore.Add(leaf.NotAfter.Sub(leaf.NotBefore) * 2 / 3)
	ari := false
	if info, _, e := renewalWindow(client.Certificate, leaf); e == nil {
		if when := info.ShouldRenewAt(time.Now(), leaf.NotAfter.Sub(time.Now())); when != nil {
			renewAt = *when
			ari = true
		}
	}
	return map[string]any{"chainPem": string(resource.Certificate), "privateKeyPem": string(resource.PrivateKey), "account": p.Account, "renewAt": renewAt.UTC().Format(time.RFC3339), "ari": ari}, nil
}

// renewalWindow reads the CA's suggested renewal window of a certificate
// (RFC 9773) and its Retry-After. A window must be a real answer: lego
// decodes any response body, and the zero window of an error document would
// read as "renew now".
func renewalWindow(certifier *certificate.Certifier, leaf *x509.Certificate) (*certificate.RenewalInfoResponse, time.Duration, error) {
	info, err := certifier.GetRenewalInfo(certificate.RenewalInfoRequest{Cert: leaf})
	if err != nil {
		return nil, 0, err
	}
	if w := info.SuggestedWindow; w.Start.IsZero() || w.End.Before(w.Start) {
		return nil, 0, errors.New("no renewal window")
	}
	return info, info.RetryAfter, nil
}

type renewalInfoParams struct {
	DirectoryURL string   `json:"directoryUrl"`
	RootCA       string   `json:"rootCa,omitempty"`
	Certificates []string `json:"certificates"`
}

// renewalInfoCommand reads the suggested renewal window of each certificate
// (all from one CA); an entry is null where the CA gives none. renewalInfo
// is a plain GET, so no account is needed.
func renewalInfoCommand(raw json.RawMessage) (any, error) {
	var p renewalInfoParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid renewal info request")
	}
	if len(p.Certificates) == 0 || len(p.Certificates) > 100 {
		return nil, fmt.Errorf("1-100 certificates are required")
	}
	u, err := url.Parse(p.DirectoryURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return nil, fmt.Errorf("ACME directory must be HTTPS")
	}
	httpClient, err := acmeHTTPClient(p.RootCA)
	if err != nil {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	core, err := api.New(httpClient, "edgeweir-certd/"+Version, p.DirectoryURL, "", key)
	if err != nil {
		return nil, fmt.Errorf("ACME directory request failed: %w", err)
	}
	certifier := certificate.NewCertifier(core, nil, certificate.CertifierOptions{})
	out := make([]any, len(p.Certificates))
	for i, text := range p.Certificates {
		block, _ := pem.Decode([]byte(text))
		if block == nil {
			continue
		}
		leaf, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			continue
		}
		info, retryAfter, err := renewalWindow(certifier, leaf)
		if errors.Is(err, api.ErrNoARI) {
			break
		}
		if err != nil {
			continue
		}
		out[i] = map[string]any{
			"start":      info.SuggestedWindow.Start.UTC().Format(time.RFC3339),
			"end":        info.SuggestedWindow.End.UTC().Format(time.RFC3339),
			"retryAfter": int(retryAfter / time.Second),
		}
	}
	return out, nil
}

// newOrderRejected reports whether err is the CA's answer to the new-order
// request itself, i.e. nothing was authorized or issued yet.
func newOrderRejected(httpClient *http.Client, directoryURL string, err error) bool {
	var problem *acme.ProblemDetails
	if !errors.As(err, &problem) || problem.Method != http.MethodPost {
		return false
	}
	resp, err := httpClient.Get(directoryURL)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var directory acme.Directory
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&directory) != nil {
		return false
	}
	return directory.NewOrderURL != "" && problem.URL == directory.NewOrderURL
}
