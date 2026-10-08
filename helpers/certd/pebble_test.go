package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"log"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/letsencrypt/pebble/v2/ca"
	pebbledb "github.com/letsencrypt/pebble/v2/db"
	"github.com/letsencrypt/pebble/v2/va"
	"github.com/letsencrypt/pebble/v2/wfe"
)

// pebbleEABKey is a base64url HMAC key, as Pebble's externalAccountMACKeys
// and lego's HmacEncoded take it.
const pebbleEABKey = "zWNDZM6eQGHWpSRTPal5eIUYFTu7EajVIoguysqZ9wG44nMEtx3MUAsUDkMTQ12W"

// pebbleDirectory runs Pebble (the ACME test CA) in this process, the way
// its cmd/pebble wires it: validations always pass, nonces are never
// rejected, and EAB keys, if any, are required. It returns the directory URL
// and the PEM of the certificate its HTTPS listener presents, which only
// certd's rootCa makes trusted: the custom directory of the system settings.
func pebbleDirectory(t *testing.T, eab map[string]string) (string, string) {
	t.Helper()
	t.Setenv("PEBBLE_VA_ALWAYS_VALID", "1")
	t.Setenv("PEBBLE_VA_NOSLEEP", "1")
	t.Setenv("PEBBLE_WFE_NONCEREJECT", "0")
	logger := log.New(io.Discard, "", 0)
	store := pebbledb.NewMemoryStore()
	authority := ca.New(logger, store, "", "ecdsa", 0, 1, map[string]ca.Profile{
		"default": {Description: "The default profile"},
	})
	validator := va.New(logger, 80, 443, false, "", store)
	for id, key := range eab {
		if err := store.AddExternalAccountKeyByID(id, key); err != nil {
			t.Fatal(err)
		}
	}
	frontend := wfe.New(logger, store, validator, authority, []string{"pebble.test"}, false, len(eab) > 0, 0, 0)
	server := httptest.NewTLSServer(frontend.Handler())
	t.Cleanup(server.Close)
	root := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	return server.URL + wfe.DirectoryPath, string(root)
}

// runObtain sends an obtain request through certd's stdin/stdout protocol,
// acknowledging every event, and returns the events and the response.
func runObtain(t *testing.T, params map[string]any) ([]map[string]any, Response) {
	t.Helper()
	request, err := json.Marshal(map[string]any{"command": "obtain", "params": params})
	if err != nil {
		t.Fatal(err)
	}
	in := string(request) + "\n" + strings.Repeat(`{"ok":true}`+"\n", 32)
	var out bytes.Buffer
	run(strings.NewReader(in), &out)
	dec := json.NewDecoder(&out)
	var lines []map[string]any
	for dec.More() {
		var line map[string]any
		if err := dec.Decode(&line); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		t.Fatal("no response")
	}
	raw, _ := json.Marshal(lines[len(lines)-1])
	var resp Response
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatal(err)
	}
	return lines[:len(lines)-1], resp
}

func issuedLeaf(t *testing.T, resp Response) *x509.Certificate {
	t.Helper()
	if !resp.OK {
		t.Fatalf("obtain failed: %s (%s)", resp.Error, resp.Code)
	}
	raw, _ := json.Marshal(resp.Result)
	var result struct {
		ChainPEM      string `json:"chainPem"`
		PrivateKeyPEM string `json:"privateKeyPem"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(result.ChainPEM))
	if block == nil {
		t.Fatal("no certificate in the chain")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.PrivateKeyPEM, "PRIVATE KEY") {
		t.Fatal("no private key")
	}
	return leaf
}

func events(lines []map[string]any) []string {
	var names []string
	for _, line := range lines {
		if name, ok := line["event"].(string); ok {
			names = append(names, name)
		}
	}
	return names
}

func TestPebbleKeyTypesFromACustomDirectory(t *testing.T) {
	directory, root := pebbleDirectory(t, nil)
	base := map[string]any{
		"email":        "ops@example.com",
		"domains":      []string{"a.g11.test", "b.g11.test"},
		"directoryUrl": directory,
		"rootCa":       root,
		"challenge":    "http01",
		"account":      map[string]any{},
	}

	lines, resp := runObtain(t, base)
	leaf := issuedLeaf(t, resp)
	key, ok := leaf.PublicKey.(*ecdsa.PublicKey)
	if !ok || key.Curve != elliptic.P256() {
		t.Fatalf("default key: %T, want ECDSA P-256", leaf.PublicKey)
	}
	if got := strings.Join(events(lines), ","); got != "account,http01.present,http01.cleanup" {
		t.Fatalf("events %q", got)
	}
	if err := leaf.VerifyHostname("b.g11.test"); err != nil {
		t.Fatal(err)
	}

	rsaParams := map[string]any{}
	for k, v := range base {
		rsaParams[k] = v
	}
	rsaParams["keyType"] = "rsa2048"
	_, resp = runObtain(t, rsaParams)
	leaf = issuedLeaf(t, resp)
	if key, ok := leaf.PublicKey.(*rsa.PublicKey); !ok || key.N.BitLen() != 2048 {
		t.Fatalf("rsa2048 key: %T, want RSA 2048", leaf.PublicKey)
	}

	bad := map[string]any{}
	for k, v := range base {
		bad[k] = v
	}
	bad["keyType"] = "ed25519"
	if _, resp = runObtain(t, bad); resp.OK || !strings.Contains(resp.Error, "key type") {
		t.Fatalf("unknown key type: %+v", resp)
	}

	// The custom directory's own certificate is not in the system roots.
	untrusted := map[string]any{}
	for k, v := range base {
		untrusted[k] = v
	}
	delete(untrusted, "rootCa")
	if _, resp = runObtain(t, untrusted); resp.OK {
		t.Fatal("a directory whose certificate is not trusted issued a certificate")
	}
}

func TestPebbleExternalAccountBinding(t *testing.T) {
	directory, root := pebbleDirectory(t, map[string]string{"kid-g11": pebbleEABKey})
	params := map[string]any{
		"email":        "ops@example.com",
		"domains":      []string{"eab.g11.test"},
		"directoryUrl": directory,
		"rootCa":       root,
		"challenge":    "http01",
		"account":      map[string]any{},
	}
	if _, resp := runObtain(t, params); resp.OK || resp.Code != "acme_external_account_required" {
		t.Fatalf("without EAB: %+v", resp)
	}
	params["account"] = map[string]any{"eabKid": "kid-g11", "eabHmacKey": pebbleEABKey}
	lines, resp := runObtain(t, params)
	issuedLeaf(t, resp)
	var account map[string]any
	for _, line := range lines {
		if line["event"] == "account" {
			account, _ = line["account"].(map[string]any)
		}
	}
	if account == nil || account["eabKid"] != "kid-g11" || account["registration"] == nil {
		t.Fatalf("account event: %+v", account)
	}
}
