package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-acme/lego/v4/acme"
)

func TestNewOrderRejected(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"newOrder":%q}`, server.URL+"/order-plz")
	}))
	defer server.Close()
	problem := func(method, path string) error {
		return &acme.ProblemDetails{Type: "urn:ietf:params:acme:error:serverInternal", HTTPStatus: 500, Method: method, URL: server.URL + path}
	}
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"new-order rejected", problem(http.MethodPost, "/order-plz"), true},
		{"wrapped new-order rejection", fmt.Errorf("obtain: %w", problem(http.MethodPost, "/order-plz")), true},
		{"finalize rejected", problem(http.MethodPost, "/finalize-order/1"), false},
		{"not a POST", problem(http.MethodGet, "/order-plz"), false},
		{"not an ACME problem", errors.New("connection reset"), false},
	}
	for _, c := range cases {
		if got := newOrderRejected(server.Client(), server.URL+"/dir", c.err); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
	server.Close()
	if newOrderRejected(server.Client(), server.URL+"/dir", problem(http.MethodPost, "/order-plz")) {
		t.Error("an unreachable directory must not be read as a new-order rejection")
	}
}
