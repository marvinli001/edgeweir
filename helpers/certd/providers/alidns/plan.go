package alidns

import (
	"github.com/libdns/libdns"
	"github.com/marvinli001/edgeweir/helpers/certd/internal/dnsx"
)

// member is an existing record of a record-per-value API.
type member struct {
	id   string
	rr   libdns.RR
	main bool // on the default line
}

type change struct {
	id string
	rr libdns.RR
}

type keep struct{ want, have libdns.RR }

// setPlan lists the writes that make each input RRset exactly the input on
// the default line.
type setPlan struct {
	wanted  []libdns.RR // input without duplicates, in input order
	kept    []keep      // members left untouched
	updates []change    // TTL changes, or surplus members rewritten to a missing value
	creates []libdns.RR
	deletes []member // other-line members first
}

// plan compares the zone with the input. Rewriting a surplus member in place
// (instead of delete + create) keeps a single-valued RRset such as a CNAME
// answering during the change.
func plan(existing []member, input []libdns.RR) setPlan {
	var pl setPlan
	sets := map[string]bool{}
	wanted := map[string]libdns.RR{}
	for _, r := range input {
		sets[dnsx.SetKey(r)] = true
		if _, dup := wanted[dnsx.Key(r)]; !dup {
			wanted[dnsx.Key(r)] = r
			pl.wanted = append(pl.wanted, r)
		}
	}
	done := map[string]bool{}
	var extras []member
	for _, m := range existing {
		if !sets[dnsx.SetKey(m.rr)] {
			continue
		}
		k := dnsx.Key(m.rr)
		if want, ok := wanted[k]; ok && m.main && !done[k] {
			done[k] = true
			if dnsx.Seconds(want.TTL) != dnsx.Seconds(m.rr.TTL) {
				pl.updates = append(pl.updates, change{id: m.id, rr: want})
			} else {
				pl.kept = append(pl.kept, keep{want: want, have: m.rr})
			}
			continue
		}
		extras = append(extras, m)
	}
	used := make([]bool, len(extras))
	for _, w := range pl.wanted {
		if done[dnsx.Key(w)] {
			continue
		}
		done[dnsx.Key(w)] = true
		reused := false
		for i, e := range extras {
			if !used[i] && e.main && dnsx.SetKey(e.rr) == dnsx.SetKey(w) {
				used[i], reused = true, true
				pl.updates = append(pl.updates, change{id: e.id, rr: w})
				break
			}
		}
		if !reused {
			pl.creates = append(pl.creates, w)
		}
	}
	for _, mainLine := range []bool{false, true} {
		for i, e := range extras {
			if !used[i] && e.main == mainLine {
				pl.deletes = append(pl.deletes, e)
			}
		}
	}
	return pl
}

// result returns the records as stored (TTLs may have been raised).
func (pl setPlan) result(stored map[string]libdns.RR) []libdns.Record {
	out := make([]libdns.Record, 0, len(pl.wanted))
	for _, w := range pl.wanted {
		if r, ok := stored[dnsx.Key(w)]; ok {
			out = append(out, r)
		} else {
			out = append(out, w)
		}
	}
	return out
}
