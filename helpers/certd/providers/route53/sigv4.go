package route53

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// AWS Signature Version 4
// (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html).

type credentials struct {
	accessKey, secretKey, token string
}

const amzDate = "20060102T150405Z"

// signV4 adds X-Amz-Date, X-Amz-Security-Token (temporary credentials) and
// Authorization to req and returns the canonical request.
func signV4(req *http.Request, body []byte, c credentials, region, service string, now time.Time) string {
	stamp := now.UTC().Format(amzDate)
	day := stamp[:8]
	req.Header.Set("X-Amz-Date", stamp)
	if c.token != "" {
		req.Header.Set("X-Amz-Security-Token", c.token)
	}
	canonical, signed := canonicalRequest(req, body)
	scope := day + "/" + region + "/" + service + "/aws4_request"
	hashed := sha256.Sum256([]byte(canonical))
	toSign := "AWS4-HMAC-SHA256\n" + stamp + "\n" + scope + "\n" + hex.EncodeToString(hashed[:])
	key := hmacSHA256([]byte("AWS4"+c.secretKey), day)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, service)
	key = hmacSHA256(key, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(key, toSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+c.accessKey+"/"+scope+", SignedHeaders="+signed+", Signature="+signature)
	return canonical
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

// canonicalRequest signs host, content-type and every x-amz-* header.
func canonicalRequest(req *http.Request, body []byte) (canonical, signed string) {
	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	headers := map[string]string{"host": host}
	for name, values := range req.Header {
		lower := strings.ToLower(name)
		if lower != "content-type" && !strings.HasPrefix(lower, "x-amz-") {
			continue
		}
		trimmed := make([]string, len(values))
		for i, v := range values {
			trimmed[i] = strings.Join(strings.Fields(v), " ")
		}
		headers[lower] = strings.Join(trimmed, ",")
	}
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	var block strings.Builder
	for _, name := range names {
		block.WriteString(name + ":" + headers[name] + "\n")
	}
	payload := sha256.Sum256(body)
	signed = strings.Join(names, ";")
	canonical = strings.Join([]string{req.Method, canonicalPath(req.URL), canonicalQuery(req.URL), block.String(), signed, hex.EncodeToString(payload[:])}, "\n")
	return canonical, signed
}

// canonicalPath encodes every segment twice, as SigV4 requires for services
// other than S3 (Route 53 paths only carry unreserved characters).
func canonicalPath(u *url.URL) string {
	if u.Path == "" {
		return "/"
	}
	segments := strings.Split(u.Path, "/")
	for i, s := range segments {
		segments[i] = uriEncode(uriEncode(s))
	}
	return strings.Join(segments, "/")
}

func canonicalQuery(u *url.URL) string {
	values, _ := url.ParseQuery(u.RawQuery)
	type pair struct{ k, v string }
	var pairs []pair
	for k, vs := range values {
		for _, v := range vs {
			pairs = append(pairs, pair{uriEncode(k), uriEncode(v)})
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].k != pairs[j].k {
			return pairs[i].k < pairs[j].k
		}
		return pairs[i].v < pairs[j].v
	})
	out := make([]string, len(pairs))
	for i, p := range pairs {
		out[i] = p.k + "=" + p.v
	}
	return strings.Join(out, "&")
}

// encodeQuery builds a query string with the SigV4 encoding, so the
// canonical form and the wire form agree.
func encodeQuery(pairs [][2]string) string {
	out := make([]string, len(pairs))
	for i, p := range pairs {
		out[i] = uriEncode(p[0]) + "=" + uriEncode(p[1])
	}
	return strings.Join(out, "&")
}

// uriEncode percent-encodes everything except A-Z a-z 0-9 - . _ ~.
func uriEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '.' || c == '_' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
