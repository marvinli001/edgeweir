package dnsx

import (
	"sort"

	"github.com/libdns/libdns"
)

// Member is an existing record of a record-per-value API (one id per value
// and line).
type Member struct {
	ID   string
	RR   libdns.RR
	Line string // as LineRecord.Line ("" is the default line)
}

// Change rewrites an existing member to Record (its line stays).
type Change struct {
	ID     string
	Record LineRecord
}

// Keep is a member that already holds a wanted record.
type Keep struct{ Want, Have LineRecord }

// SetPlan lists the writes that make each input (name, type) exactly the
// input records on every line.
type SetPlan struct {
	Wanted  []LineRecord // input without duplicates, in input order
	Kept    []Keep       // members left untouched
	Updates []Change     // TTL changes, or surplus members rewritten to a missing value on their line
	Creates []LineRecord // default-line records first
	Deletes []Member     // members on other lines first, the default line last
}

// PlanKey identifies a record on its line.
func PlanKey(r LineRecord) string { return Key(r.Record) + "\x00" + NormalizeLine(r.Line) }

// PlanSet compares the zone with the input of SetRecords. Copies of an
// input (name, type) on lines the input does not use are deleted, so an
// input on the default line only leaves no other-line copies. Rewriting a
// surplus member in place on its own line (instead of delete + create)
// keeps a single-valued RRset such as a CNAME answering during the change.
// Default-line records are created before other lines and deleted after
// them: some providers want a default-line record while other lines exist.
func PlanSet(existing []Member, input []libdns.Record) SetPlan {
	var pl SetPlan
	sets := map[string]bool{}
	wanted := map[string]LineRecord{}
	for _, r := range input {
		lr := LineRecord{Record: r.RR(), Line: LineOf(r)}
		sets[SetKey(lr.Record)] = true
		if _, dup := wanted[PlanKey(lr)]; !dup {
			wanted[PlanKey(lr)] = lr
			pl.Wanted = append(pl.Wanted, lr)
		}
	}
	done := map[string]bool{}
	var extras []Member
	for _, m := range existing {
		if !sets[SetKey(m.RR)] {
			continue
		}
		have := LineRecord{Record: m.RR, Line: NormalizeLine(m.Line)}
		k := PlanKey(have)
		if want, ok := wanted[k]; ok && !done[k] {
			done[k] = true
			if Seconds(want.Record.TTL) != Seconds(m.RR.TTL) {
				pl.Updates = append(pl.Updates, Change{ID: m.ID, Record: want})
			} else {
				pl.Kept = append(pl.Kept, Keep{Want: want, Have: have})
			}
			continue
		}
		extras = append(extras, m)
	}
	order := append([]LineRecord(nil), pl.Wanted...)
	sort.SliceStable(order, func(i, j int) bool { return order[i].Line == "" && order[j].Line != "" })
	used := make([]bool, len(extras))
	for _, w := range order {
		if done[PlanKey(w)] {
			continue
		}
		done[PlanKey(w)] = true
		reused := false
		for i, e := range extras {
			if !used[i] && NormalizeLine(e.Line) == w.Line && SetKey(e.RR) == SetKey(w.Record) {
				used[i], reused = true, true
				pl.Updates = append(pl.Updates, Change{ID: e.ID, Record: w})
				break
			}
		}
		if !reused {
			pl.Creates = append(pl.Creates, w)
		}
	}
	for _, defaultLine := range []bool{false, true} {
		for i, e := range extras {
			if !used[i] && (NormalizeLine(e.Line) == "") == defaultLine {
				pl.Deletes = append(pl.Deletes, e)
			}
		}
	}
	return pl
}

// Result returns the wanted records as stored (TTLs may have been raised),
// keyed by PlanKey.
func (pl SetPlan) Result(stored map[string]libdns.RR) []libdns.Record {
	out := make([]libdns.Record, 0, len(pl.Wanted))
	for _, w := range pl.Wanted {
		rr := w.Record
		if r, ok := stored[PlanKey(w)]; ok {
			rr = r
		}
		out = append(out, OnLine(rr, w.Line))
	}
	return out
}
