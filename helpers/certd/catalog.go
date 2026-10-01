package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// catalog.json is generated from packages/contract/src/dns-providers.ts, the
// one definition of the providers and their credential fields.
//
//go:embed catalog.json
var catalogJSON []byte

type catalogField struct {
	Key       string   `json:"key"`
	Type      string   `json:"type"`
	Secret    bool     `json:"secret"`
	Required  bool     `json:"required"`
	Pattern   string   `json:"pattern"`
	MaxLength int      `json:"maxLength"`
	Options   []string `json:"options"`
	Default   string   `json:"default"`
}
type catalogEntry struct {
	ID           string         `json:"id"`
	Fields       []catalogField `json:"fields"`
	Capabilities struct {
		ListZones bool   `json:"listZones"`
		Endpoint  string `json:"endpoint"`
	} `json:"capabilities"`
}

var catalog = func() map[string]catalogEntry {
	var entries []catalogEntry
	if err := json.Unmarshal(catalogJSON, &entries); err != nil {
		panic("invalid catalog.json: " + err.Error())
	}
	out := make(map[string]catalogEntry, len(entries))
	for _, e := range entries {
		for _, f := range e.Fields {
			if f.Pattern != "" {
				regexp.MustCompile(f.Pattern)
			}
		}
		out[e.ID] = e
	}
	return out
}()

// credentialFields checks credentials the way the console does
// (checkDnsCredentials): only known keys, required ones present, no control
// characters, within length, matching the pattern and options; URL fields
// http(s) without user info or fragment. Optional fields fall back to their
// default. Errors never contain values.
func credentialFields(provider string, raw json.RawMessage) (map[string]string, error) {
	entry, ok := catalog[provider]
	if !ok {
		return nil, fmt.Errorf("%w: unsupported DNS provider", dnsx.ErrInvalid)
	}
	var input map[string]string
	if len(raw) == 0 || json.Unmarshal(raw, &input) != nil {
		return nil, fmt.Errorf("%w: invalid DNS credentials", dnsx.ErrInvalid)
	}
	known := map[string]bool{}
	for _, f := range entry.Fields {
		known[f.Key] = true
	}
	for key := range input {
		if !known[key] {
			return nil, fmt.Errorf("%w: unknown DNS credential field", dnsx.ErrInvalid)
		}
	}
	out := map[string]string{}
	for _, f := range entry.Fields {
		value := input[f.Key]
		if f.Type != "textarea" && !f.Secret {
			value = strings.TrimSpace(value)
		}
		if value == "" {
			if f.Required {
				return nil, fmt.Errorf("%w: DNS credential field %s is required", dnsx.ErrInvalid, f.Key)
			}
			if f.Default != "" {
				out[f.Key] = f.Default
			}
			continue
		}
		invalid := fmt.Errorf("%w: invalid DNS credential field %s", dnsx.ErrInvalid, f.Key)
		if !utf8.ValidString(value) || utf8.RuneCountInString(value) > f.MaxLength {
			return nil, invalid
		}
		for _, c := range value {
			if (c < 0x20 && !(f.Type == "textarea" && (c == '\t' || c == '\n' || c == '\r'))) || c == 0x7f {
				return nil, invalid
			}
		}
		if f.Pattern != "" && !regexp.MustCompile(f.Pattern).MatchString(value) {
			return nil, invalid
		}
		if len(f.Options) > 0 && !contains(f.Options, value) {
			return nil, invalid
		}
		if f.Type == "url" {
			u, err := url.Parse(value)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Fragment != "" {
				return nil, invalid
			}
		}
		out[f.Key] = value
	}
	return out, nil
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
