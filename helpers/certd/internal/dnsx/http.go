package dnsx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// MaxBody bounds every provider response.
const MaxBody = 16 << 20

// Do sends a request and returns the status and body (at most MaxBody).
// Transport errors become ErrUnreachable without the URL, which may carry
// credentials in its query string.
func Do(client *http.Client, req *http.Request) (int, []byte, error) {
	res, err := client.Do(req)
	if err != nil {
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		if errors.Is(err, ErrRefused) {
			return 0, nil, err
		}
		if errors.Is(err, context.Canceled) {
			return 0, nil, err
		}
		return 0, nil, fmt.Errorf("%w: %s", ErrUnreachable, Short(err.Error()))
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, MaxBody+1))
	if err != nil {
		return res.StatusCode, nil, fmt.Errorf("%w: reading response", ErrUnreachable)
	}
	if len(body) > MaxBody {
		return res.StatusCode, nil, fmt.Errorf("%w: response too large", ErrProvider)
	}
	return res.StatusCode, body, nil
}

// JSON sends a request with an optional JSON body and decodes a 2xx JSON
// answer into out (when out is not nil). Other statuses become a
// StatusError whose message comes from describe (may be nil).
func JSON(ctx context.Context, client *http.Client, method, target string, header http.Header, in, out any, describe func([]byte) string) error {
	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return fmt.Errorf("%w: encoding request", ErrInvalid)
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return fmt.Errorf("%w: building request", ErrInvalid)
	}
	for key, values := range header {
		for _, v := range values {
			req.Header.Add(key, v)
		}
	}
	if in != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if req.Header.Get("Accept") == "" {
		req.Header.Set("Accept", "application/json")
	}
	status, raw, err := Do(client, req)
	if err != nil {
		return err
	}
	if status < 200 || status > 299 {
		message := ""
		if describe != nil {
			message = Short(describe(raw))
		}
		return &StatusError{Status: status, Message: message}
	}
	if out == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%w: invalid JSON response", ErrProvider)
	}
	return nil
}
