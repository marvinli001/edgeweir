package dnsx

import (
	"fmt"
	"strings"

	"github.com/libdns/libdns"
)

// Resolution lines: one name answers differently per carrier or region.
// The console speaks canonical line ids (packages/contract DNS_LINES); the
// adapters of providers with lines map them to the provider's own ids. A
// record without a line is on the default line, which answers every
// resolver no other line matches.
const DefaultLine = "default"

// Lines are the canonical lines in catalog order.
var Lines = []string{DefaultLine, "telecom", "unicom", "mobile", "edu", "overseas"}

// otherPrefix marks a provider line without a canonical id (a province or
// custom line). Such records are listed and deleted, never written.
const otherPrefix = "other:"

// LineRecord is a record on a resolution line. It implements libdns.Record.
type LineRecord struct {
	Record libdns.RR
	// Line is a canonical id, "" for the default line, or "other:<provider
	// line>" for a line without one.
	Line string
}

// RR returns the record.
func (r LineRecord) RR() libdns.RR { return r.Record }

// NormalizeLine returns the line as LineRecord stores it ("default" -> "").
func NormalizeLine(line string) string {
	if line == DefaultLine {
		return ""
	}
	return line
}

// LineOf returns the line of a record: "" (default) unless it is a
// LineRecord on another line.
func LineOf(r libdns.Record) string {
	switch v := r.(type) {
	case LineRecord:
		return NormalizeLine(v.Line)
	case *LineRecord:
		return NormalizeLine(v.Line)
	}
	return ""
}

// OnLine returns rr on the line: rr itself on the default line, otherwise
// a LineRecord.
func OnLine(rr libdns.RR, line string) libdns.Record {
	if line = NormalizeLine(line); line == "" {
		return rr
	}
	return LineRecord{Record: rr, Line: line}
}

// LineKey identifies a record on its line (name, type, data, line).
func LineKey(r libdns.Record) string { return Key(r.RR()) + "\x00" + LineOf(r) }

// MatchesOnLine reports whether an existing record is selected by a delete
// input: same line, then Matches (name, type, and data when given).
func MatchesOnLine(existing, input libdns.Record) bool {
	return LineOf(existing) == LineOf(input) && Matches(existing.RR(), input.RR())
}

// IsCanonicalLine reports whether line is a canonical id ("" counts as the
// default line).
func IsCanonicalLine(line string) bool {
	if line == "" {
		return true
	}
	for _, l := range Lines {
		if l == line {
			return true
		}
	}
	return false
}

// LineMap maps canonical lines ("default" included) to a provider's line
// identifiers.
type LineMap map[string]string

// Provider returns the provider identifier of a canonical line ("" is the
// default line); a line the map does not have is unsupported.
func (m LineMap) Provider(line string) (string, error) {
	if line == "" {
		line = DefaultLine
	}
	if id, ok := m[line]; ok {
		return id, nil
	}
	return "", fmt.Errorf("%w: resolution line %q is not supported by this provider", ErrUnsupported, line)
}

// Canonical returns the line of a provider identifier: "" for the default
// line, the canonical id, or "other:<id>" when the map does not have it.
func (m LineMap) Canonical(id string) string {
	for line, provider := range m {
		if provider == id {
			return NormalizeLine(line)
		}
	}
	return otherPrefix + id
}

// Lines returns the canonical lines of the map in catalog order.
func (m LineMap) Lines() []string {
	var out []string
	for _, l := range Lines {
		if _, ok := m[l]; ok {
			out = append(out, l)
		}
	}
	return out
}

// Check returns ErrUnsupported when a record is on a line the map does not
// have.
func (m LineMap) Check(records []libdns.Record) error {
	for _, r := range records {
		if _, err := m.Provider(LineOf(r)); err != nil {
			return err
		}
	}
	return nil
}

// IsOtherLine reports whether a line is a provider line without a canonical id.
func IsOtherLine(line string) bool { return strings.HasPrefix(line, otherPrefix) }
