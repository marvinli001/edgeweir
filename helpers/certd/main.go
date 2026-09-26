// Command edgeweir-certd is the console's ACME / DNS helper.
//
// The console (a pg-boss job) runs it as a short-lived process and talks to
// it with one JSON request on stdin and one JSON response on stdout, so no
// secrets ever appear on the command line or in the environment of other
// processes. Certificates will be obtained with lego (ACME, ARI, DNS-01) and
// DNS records managed with libdns providers (DNSPod, Alibaba Cloud, Huawei
// Cloud, Cloudflare, ...). Phase 0 ships the protocol and the skeleton only.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// Version is set at build time with -ldflags "-X main.Version=...".
var Version = "0.1.0-dev"

// Request is the single JSON document read from stdin.
type Request struct {
	Command string          `json:"command"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Response is the single JSON document written to stdout.
type Response struct {
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
	Result any    `json:"result,omitempty"`
}

// Providers lists the DNS providers the helper will support through libdns.
var Providers = []string{"dnspod", "alidns", "huaweicloud", "cloudflare"}

func handle(req Request, session *protocolSession) Response {
	switch req.Command {
	case "version":
		return Response{OK: true, Result: map[string]string{"version": Version}}
	case "providers":
		return Response{OK: true, Result: Providers}
	case "obtain", "renew", "revoke", "dns.list", "dns.set", "dns.present", "dns.cleanup":
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		var result any
		var err error
		if strings.HasPrefix(req.Command, "dns.") {
			result, err = dnsCommand(ctx, req.Command, req.Params)
		} else {
			result, err = acmeCommand(ctx, req.Command, req.Params, session)
		}
		if err != nil {
			return Response{Error: err.Error()}
		}
		return Response{OK: true, Result: result}
	default:
		return Response{OK: false, Error: fmt.Sprintf("unknown command %q", req.Command)}
	}
}

func run(in io.Reader, out io.Writer) int {
	var req Request
	dec := json.NewDecoder(io.LimitReader(in, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		_ = json.NewEncoder(out).Encode(Response{Error: "invalid request: " + err.Error()})
		return 2
	}
	resp := handle(req, &protocolSession{input: dec, output: json.NewEncoder(out)})
	if err := json.NewEncoder(out).Encode(resp); err != nil {
		return 1
	}
	if !resp.OK {
		return 1
	}
	return 0
}

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "version" || os.Args[1] == "--version") {
		fmt.Println(Version)
		return
	}
	os.Exit(run(os.Stdin, os.Stdout))
}
