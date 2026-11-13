package opencode

import (
	"regexp"
	"strings"
	"sync"
	"testing"
)

// The vectors below were computed by executing the verbatim arithmetic of
// the pinned native identifier.ts create() (/tmp/opencode-2032-parity, the
// file is byte-identical in the 2.1.4 and 2.2.5 trees) in a script that also
// asserts each relevant source line is present verbatim before computing:
// /tmp/oc-vectors/{compute,final,roundtrip,debug2}.mjs. The six real-world
// session ids from the audited evidence (session_test.go) all solve to
// counter=1 with a fresh process (first ID at that millisecond), under the
// single 36-bit-timestamp wrap k=26 that places their creation dates in the
// deployment window (2026-10-27 .. 2026-11-01); the wall-clock interpretation
// is documented here as reference behavior, not asserted by the plugin.

// TestDescendingIdentifierExactVectors pins the EXACT native bit mapping:
// current = ts*0x1000 + counter; value = ~current; low 48 bits as six
// big-endian hex bytes. These are source-derived vectors, not plugin output.
func TestDescendingIdentifierExactVectors(t *testing.T) {
	vectors := []struct {
		ts      int64
		counter int64
		want    string
	}{
		// the six audited real session ids, solved to (ts, counter=1):
		{1793526083674, 1, "e6983cfa5ffe"}, // ses_e6983cfa5ffe...
		{1793522260953, 1, "e69be2426ffe"}, // ses_e69be2426ffe...
		{1793179715005, 1, "e7e28fa42ffe"}, // ses_e7e28fa42ffe...
		{1793088475488, 1, "e83992e9fffe"}, // ses_e83992e9fffe...
		{1793179439080, 1, "e7e2d3017ffe"}, // ses_e7e2d3017ffe...
		{1793138470269, 1, "e809e5282ffe"}, // ses_e809e5282ffe...
		// state-machine pins from the verbatim source:
		{1762000000000, 4096, "5c09dabfefff"}, // counter carry into ts bits (0x1000)
		{1762000000000, 4097, "5c09dabfeffe"}, // carry + 1
		{1000000000, 123, "fc46535fff84"},     // far-past ts, mid counter
	}
	for _, vec := range vectors {
		idGen.reset()
		var got string
		for i := int64(0); i < vec.counter; i++ {
			got = idGen.identifierTimeParts(true, vec.ts)
		}
		if got != vec.want {
			t.Errorf("identifierTimeParts(desc, ts=%d, counter=%d) = %q, want %q (verbatim source vector)", vec.ts, vec.counter, got, vec.want)
		}
	}
}

// TestAscendingDescendingInversion pins the native inversion relation: with
// identical (ts, counter) state, ascending == ~descending over the low 48
// bits (identifier.ts: value = descending ? ~current : current).
func TestAscendingDescendingInversion(t *testing.T) {
	idGen.reset()
	asc := idGen.identifierTimeParts(false, 1762000000000)
	idGen.reset()
	desc := idGen.identifierTimeParts(true, 1762000000000)
	// ~a3f625400001 = 5c09dabffffe (verified against the source arithmetic)
	if asc != "a3f625400001" || desc != "5c09dabffffe" {
		t.Errorf("ascending/descending = %q/%q, want a3f625400001/5c09dabffffe", asc, desc)
	}
}

// TestDescendingIdentifierCounterResetsOnNewMillisecond pins the native
// module-state rule: counter resets to 0 on a timestamp change, so the first
// id at a new ms follows the last id at the previous ms directly.
func TestDescendingIdentifierCounterResetsOnNewMillisecond(t *testing.T) {
	idGen.reset()
	first := idGen.identifierTimeParts(true, 1762000000000)  // counter 1
	idGen.identifierTimeParts(true, 1762000000000)           // counter 2
	idGen.identifierTimeParts(true, 1762000000000)           // counter 3
	next := idGen.identifierTimeParts(true, 1762000000001)   // counter 1 (reset)
	idGen.reset()
	wantNext := idGen.identifierTimeParts(true, 1762000000001)
	if next != wantNext {
		t.Errorf("first id at new ms = %q, want fresh-state %q (counter resets on ts change)", next, wantNext)
	}
	if first == next {
		t.Errorf("distinct ms produced identical time parts %q", first)
	}
}

// TestNewSessionIDShapeAndAlphabet pins the full generated id: "ses_" + 12
// lowercase hex + 14 chars of the 62-char alphabet, random segment drawn
// from crypto/rand (the native getRandomValues + byte%62 mapping).
func TestNewSessionIDShapeAndAlphabet(t *testing.T) {
	pattern := regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`)
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		id, err := NewSessionID(1762000000000)
		if err != nil {
			t.Fatalf("NewSessionID error = %v", err)
		}
		if !pattern.MatchString(id) {
			t.Fatalf("NewSessionID = %q, want the exact native shape", id)
		}
		// The time part must be the pinned descending value for counter=1 at
		// this ms within a burst: first call of the loop is counter=1 only
		// when the ms changes; assert the alphabet/hex split instead.
		body := strings.TrimPrefix(id, "ses_")
		for j := 0; j < 12; j++ {
			c := body[j]
			if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
				t.Errorf("time part %q has non-lowercase-hex char %q", body[:12], c)
			}
		}
		for j := 12; j < 26; j++ {
			if !strings.ContainsRune(identifierChars, rune(body[j])) {
				t.Errorf("random tail char %q not in the native 62-char alphabet", body[j])
			}
		}
		seen[id] = true
	}
	// The random tail must actually vary: 200 draws, no duplicates beyond
	// birthday-bound noise. With 62^14 space, zero collisions expected.
	if len(seen) != 200 {
		t.Errorf("NewSessionID produced %d distinct ids over 200 draws; random tail is not varying", len(seen))
	}
}

// TestNewSessionIDMatchesKnownWorkingShape pins that a fresh mint is
// indistinguishable in shape from the audited real ids (the same generator
// the native runtime uses), while never claiming those specific ids.
func TestNewSessionIDMatchesKnownWorkingShape(t *testing.T) {
	id, err := NewSessionID(1793526083674)
	if err != nil {
		t.Fatalf("NewSessionID error = %v", err)
	}
	if !ValidSessionID(id) {
		t.Errorf("minted id %q fails the native shape validation", id)
	}
	if !strings.HasPrefix(id, "ses_e6983cfa5ffe") {
		t.Errorf("minted id %q does not carry the exact source vector time part for ts=1793526083674 counter=1", id)
	}
}

// TestIdentifierConcurrency pins that the counter stays exact under parallel
// minting: 8 goroutines x 1000 ids at one fixed ms yield counters 1..8000
// with no duplicates of the time part beyond the counter value (time parts
// repeat only when the same counter value repeats, which cannot happen).
func TestIdentifierConcurrency(t *testing.T) {
	idGen.reset()
	const workers, perWorker = 8, 1000
	var wg sync.WaitGroup
	results := make(chan string, workers*perWorker)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				results <- idGen.identifierTimeParts(true, 1762000000000)
			}
		}()
	}
	wg.Wait()
	close(results)
	distinct := map[string]int{}
	total := 0
	for part := range results {
		distinct[part]++
		total++
	}
	if total != workers*perWorker {
		t.Fatalf("collected %d parts, want %d", total, workers*perWorker)
	}
	// 8000 sequential counters at one ms: exactly 8000 distinct time parts
	// (counter is monotonic per call under the mutex).
	if len(distinct) != total {
		t.Errorf("distinct time parts = %d, want %d (counter lost updates under concurrency)", len(distinct), total)
	}
}
