// A small CI probe: HTTP/3 must work even when the runner's curl lacks QUIC.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
)

func main() {
	address := flag.String("address", "127.0.0.1:18443", "UDP address")
	target := flag.String("url", "https://https.m3.test:18443/", "request URL")
	ca := flag.String("ca", "", "trusted CA PEM path")
	flag.Parse()
	data, err := os.ReadFile(*ca)
	if err != nil {
		panic(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(data) {
		panic("invalid CA")
	}
	transport := &http3.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13}, Dial: func(ctx context.Context, _ string, config *tls.Config, quicConfig *quic.Config) (*quic.Conn, error) {
		return quic.DialAddr(ctx, *address, config, quicConfig)
	}}
	defer transport.Close()
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second}
	response, err := client.Get(*target)
	if err != nil {
		panic(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || response.ProtoMajor != 3 {
		panic(fmt.Sprintf("unexpected response: %s %d", response.Proto, response.StatusCode))
	}
	if _, err = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<20)); err != nil {
		panic(err)
	}
	fmt.Print("3")
}
