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
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

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

type httpChallenge struct{ session *protocolSession }

func (p *httpChallenge) Present(domain, token, authorization string) error {
	return p.session.event(map[string]any{"event": "http01.present", "domain": domain, "token": token, "keyAuthorization": authorization})
}
func (p *httpChallenge) CleanUp(domain, token, _ string) error {
	return p.session.event(map[string]any{"event": "http01.cleanup", "domain": domain, "token": token})
}

func acmeCommand(ctx context.Context, command string, raw json.RawMessage, session *protocolSession) (any, error) {
	var p acmeParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid ACME request")
	}
	if len(p.Domains) == 0 || len(p.Domains) > 100 || p.Email == "" {
		return nil, fmt.Errorf("email and 1-100 domains are required")
	}
	u, err := url.Parse(p.DirectoryURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return nil, fmt.Errorf("ACME directory must be HTTPS")
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
	config.Certificate.KeyType = certcrypto.EC256
	config.Certificate.Timeout = 2 * time.Minute
	roots, err := x509.SystemCertPool()
	if err != nil {
		roots = x509.NewCertPool()
	}
	if p.RootCA != "" && !roots.AppendCertsFromPEM([]byte(p.RootCA)) {
		return nil, fmt.Errorf("invalid ACME trust certificate")
	}
	config.HTTPClient = &http.Client{Timeout: 45 * time.Second, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}}}
	client, err := lego.NewClient(config)
	if err != nil {
		return nil, fmt.Errorf("ACME directory request failed: %w", err)
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
		err = client.Challenge.SetHTTP01Provider(&httpChallenge{session: session})
	case "dns01":
		if p.DNS == nil {
			return nil, fmt.Errorf("DNS-01 credentials are required")
		}
		provider, e := providerFor(*p.DNS)
		if e != nil {
			return nil, e
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
	if info, e := client.Certificate.GetRenewalInfo(certificate.RenewalInfoRequest{Cert: leaf}); e == nil {
		if when := info.ShouldRenewAt(time.Now(), leaf.NotAfter.Sub(time.Now())); when != nil {
			renewAt = *when
			ari = true
		}
	}
	return map[string]any{"chainPem": string(resource.Certificate), "privateKeyPem": string(resource.PrivateKey), "account": p.Account, "renewAt": renewAt.UTC().Format(time.RFC3339), "ari": ari}, nil
}
