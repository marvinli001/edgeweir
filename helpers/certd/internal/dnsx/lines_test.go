package dnsx

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/libdns/libdns"
)

func a(name, ip string, ttl int, line string) libdns.Record {
	return OnLine(libdns.RR{Name: name, Type: "A", Data: ip, TTL: time.Duration(ttl) * time.Second}, line)
}

func TestLineRecords(t *testing.T) {
	rr := libdns.RR{Name: "all", Type: "A", Data: "192.0.2.1", TTL: time.Minute}
	if r := OnLine(rr, "default"); LineOf(r) != "" || r != libdns.Record(rr) {
		t.Fatalf("default line: %#v", r)
	}
	if r := OnLine(rr, "telecom"); LineOf(r) != "telecom" || r.RR() != rr {
		t.Fatalf("telecom: %#v", r)
	}
	if LineOf(&LineRecord{Record: rr, Line: "default"}) != "" || LineOf(LineRecord{Record: rr, Line: "edu"}) != "edu" {
		t.Fatal("LineOf")
	}
	if LineKey(OnLine(rr, "telecom")) == LineKey(rr) || LineKey(OnLine(rr, "default")) != LineKey(rr) {
		t.Fatal("LineKey")
	}
	if MatchesOnLine(OnLine(rr, "telecom"), libdns.RR{Name: "all", Type: "A"}) {
		t.Fatal("a delete without a line must not match another line")
	}
	if !MatchesOnLine(OnLine(rr, "telecom"), OnLine(libdns.RR{Name: "ALL", Type: "a"}, "telecom")) {
		t.Fatal("same line, whole RRset")
	}
	for _, line := range []string{"", "default", "telecom", "unicom", "mobile", "edu", "overseas"} {
		if !IsCanonicalLine(line) {
			t.Errorf("%q is canonical", line)
		}
	}
	for _, line := range []string{"Default", "oversea", "other:10=4", "cn"} {
		if IsCanonicalLine(line) {
			t.Errorf("%q is not canonical", line)
		}
	}
}

func TestLineMap(t *testing.T) {
	m := LineMap{"default": "0", "telecom": "10=0"}
	if id, err := m.Provider(""); err != nil || id != "0" {
		t.Fatalf("default: %q %v", id, err)
	}
	if _, err := m.Provider("unicom"); !errors.Is(err, ErrUnsupported) || Code(err) != "dns_unsupported" {
		t.Fatalf("unicom: %v", err)
	}
	if m.Canonical("0") != "" || m.Canonical("10=0") != "telecom" || m.Canonical("10=1") != "other:10=1" {
		t.Fatal("Canonical")
	}
	if fmt.Sprint(m.Lines()) != "[default telecom]" {
		t.Fatalf("Lines %v", m.Lines())
	}
	if err := m.Check([]libdns.Record{a("x", "192.0.2.1", 60, ""), a("x", "192.0.2.1", 60, "telecom")}); err != nil {
		t.Fatal(err)
	}
	if err := m.Check([]libdns.Record{a("x", "192.0.2.1", 60, "mobile")}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("mobile: %v", err)
	}
	if !IsOtherLine(m.Canonical("10=4")) || IsOtherLine("telecom") {
		t.Fatal("IsOtherLine")
	}
}

func members(list ...Member) []Member { return list }

func TestPlanSetAcrossLines(t *testing.T) {
	existing := members(
		Member{ID: "1", RR: a("all", "192.0.2.1", 600, "").RR()},
		Member{ID: "2", RR: a("all", "192.0.2.2", 600, "").RR()},
		Member{ID: "3", RR: a("all", "192.0.2.3", 600, "").RR(), Line: "telecom"},
		Member{ID: "4", RR: a("all", "192.0.2.4", 600, "").RR(), Line: "unicom"},
		Member{ID: "5", RR: a("all", "192.0.2.5", 600, "").RR(), Line: "other:10=4"},
		Member{ID: "6", RR: a("www", "192.0.2.6", 600, "").RR(), Line: "telecom"}, // another name: untouched
	)
	pl := PlanSet(existing, []libdns.Record{
		a("all", "192.0.2.7", 600, "telecom"), // rewrites 3 on its line
		a("all", "192.0.2.1", 60, ""),         // TTL change of 1
		a("all", "192.0.2.8", 600, "mobile"),  // created
		a("all", "192.0.2.9", 600, "default"), // rewrites 2 on the default line
		a("all", "192.0.2.1", 60, "default"),  // duplicate
	})
	got := fmt.Sprint(len(pl.Wanted), " kept ", len(pl.Kept), " updates")
	for _, u := range pl.Updates {
		got += fmt.Sprintf(" %s=%s/%s", u.ID, u.Record.Record.Data, u.Record.Line)
	}
	got += " creates"
	for _, c := range pl.Creates {
		got += fmt.Sprintf(" %s/%s", c.Record.Data, c.Line)
	}
	got += " deletes"
	for _, d := range pl.Deletes {
		got += " " + d.ID
	}
	want := "4 kept 0 updates 1=192.0.2.1/ 2=192.0.2.9/ 3=192.0.2.7/telecom creates 192.0.2.8/mobile deletes 4 5"
	if got != want {
		t.Fatalf("plan\n got %s\nwant %s", got, want)
	}
	result := pl.Result(map[string]libdns.RR{PlanKey(pl.Wanted[0]): a("all", "192.0.2.7", 900, "").RR()})
	if len(result) != 4 || LineOf(result[0]) != "telecom" || result[0].RR().TTL != 900*time.Second || LineOf(result[1]) != "" {
		t.Fatalf("result %v", result)
	}
}

func TestPlanSetDefaultLineOnlyDeletesOtherLines(t *testing.T) {
	// An input on the default line only behaves as before lines: other-line copies go.
	pl := PlanSet(members(
		Member{ID: "1", RR: a("all", "192.0.2.1", 600, "").RR(), Line: "telecom"},
		Member{ID: "2", RR: a("all", "192.0.2.1", 600, "").RR()},
		Member{ID: "3", RR: a("all", "192.0.2.3", 600, "").RR()},
	), []libdns.Record{a("all", "192.0.2.1", 600, "")})
	if len(pl.Kept) != 1 || pl.Kept[0].Have.Line != "" || len(pl.Updates) != 0 || len(pl.Creates) != 0 ||
		len(pl.Deletes) != 2 || pl.Deletes[0].ID != "1" || pl.Deletes[1].ID != "3" {
		t.Fatalf("plan %+v", pl)
	}
}

func TestPlanSetCreatesTheDefaultLineFirst(t *testing.T) {
	pl := PlanSet(nil, []libdns.Record{a("all", "192.0.2.2", 600, "telecom"), a("all", "192.0.2.1", 600, "")})
	if len(pl.Creates) != 2 || pl.Creates[0].Line != "" || pl.Creates[1].Line != "telecom" {
		t.Fatalf("creates %+v", pl.Creates)
	}
	if pl.Wanted[0].Line != "telecom" {
		t.Fatal("Wanted keeps the input order")
	}
}
