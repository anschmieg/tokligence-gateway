package opencode

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
)

// fakeClock is a controllable NowMs.
type fakeClock struct{ now atomic.Int64 }

func (c *fakeClock) Now() int64        { return c.now.Load() }
func (c *fakeClock) Advance(ms int64)  { c.now.Add(ms) }
func newFakeClock(start int64) *fakeClock {
	c := &fakeClock{}
	c.now.Store(start)
	return c
}

func tempStatePath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "opencode-sessions.json")
}

// TestRegistryCreateIsStableAcrossRestart pins persistence: a mapping
// created with a persisted registry is returned unchanged by a fresh
// registry over the same state file (and the minted id is native-shaped).
func TestRegistryCreateIsStableAcrossRestart(t *testing.T) {
	path := tempStatePath(t)
	clock := newFakeClock(1762000000000)
	r1, err := NewSessionRegistry(RegistryOptions{Path: path, NowMs: clock.Now})
	if err != nil {
		t.Fatalf("open registry: %v", err)
	}
	sid, err := r1.Create("principalA", "conv-1")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !ValidSessionID(sid) {
		t.Fatalf("minted id %q is not native-shaped", sid)
	}
	r1.Close()
	r2, err := NewSessionRegistry(RegistryOptions{Path: path, NowMs: clock.Now})
	if err != nil {
		t.Fatalf("reopen registry: %v", err)
	}
	defer r2.Close()
	if got := r2.Lookup("principalA", "conv-1"); got != sid {
		t.Errorf("after restart Lookup = %q, want the same session id %q", got, sid)
	}
	again, err := r2.Create("principalA", "conv-1")
	if err != nil || again != sid {
		t.Errorf("Create after restart = %q %v, want the same id", again, err)
	}
}

// TestRegistryPartitionsPrincipals pins strict principal partition: the same
// conversation under two principals maps to two distinct session ids, and
// neither principal can look up the other's mapping.
func TestRegistryPartitionsPrincipals(t *testing.T) {
	clock := newFakeClock(1762000000000)
	r, err := NewSessionRegistry(RegistryOptions{NowMs: clock.Now})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer r.Close()
	sidA, err := r.Create("principalA", "conv-shared")
	if err != nil {
		t.Fatalf("create A: %v", err)
	}
	sidB, err := r.Create("principalB", "conv-shared")
	if err != nil {
		t.Fatalf("create B: %v", err)
	}
	if sidA == sidB {
		t.Errorf("principals share a session id %q; partition violated", sidA)
	}
	if got := r.Lookup("principalA", "conv-shared"); got != sidA {
		t.Errorf("principalA lookup = %q, want its own %q", got, sidA)
	}
	if got := r.Lookup("principalB", "conv-shared"); got != sidB {
		t.Errorf("principalB lookup = %q, want its own %q", got, sidB)
	}
	if got := r.Lookup("principalC", "conv-shared"); got != "" {
		t.Errorf("unknown principal lookup = %q, want empty", got)
	}
}

// TestRegistryConcurrentCreateSingleMapping pins that concurrent Create
// calls for one (principal, conversation) converge on exactly one session id
// (no duplicate minting, no lost update).
func TestRegistryConcurrentCreateSingleMapping(t *testing.T) {
	clock := newFakeClock(1762000000000)
	r, err := NewSessionRegistry(RegistryOptions{NowMs: clock.Now})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer r.Close()
	const workers = 16
	ids := make(chan string, workers)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sid, err := r.Create("principalA", "conv-1")
			if err != nil {
				t.Errorf("concurrent create: %v", err)
				return
			}
			ids <- sid
		}()
	}
	wg.Wait()
	close(ids)
	seen := map[string]bool{}
	for sid := range ids {
		seen[sid] = true
	}
	if len(seen) != 1 {
		t.Errorf("concurrent Create produced %d distinct ids, want exactly one", len(seen))
	}
	for sid := range seen {
		if !ValidSessionID(sid) {
			t.Errorf("minted id %q not native-shaped", sid)
		}
	}
}

// TestRegistryActiveLeasesSurviveEviction pins eviction protection: with a
// tiny TTL and LRU bound, an ACTIVE entry is never evicted while idle ones
// (including older/larger ones) are.
func TestRegistryActiveLeasesSurviveEviction(t *testing.T) {
	path := tempStatePath(t)
	clock := newFakeClock(1762000000000)
	r, err := NewSessionRegistry(RegistryOptions{Path: path, NowMs: clock.Now, IdleTTLMS: 1000, MaxIdleEntries: 1})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer r.Close()
	sidKeep, err := r.Create("principalA", "conv-active")
	if err != nil {
		t.Fatalf("create active: %v", err)
	}
	// Reference BEFORE adding more entries: Create evicts immediately once
	// the LRU bound is exceeded, so the lease must exist first.
	if err := r.Reference("principalA", "conv-active"); err != nil {
		t.Fatalf("reference: %v", err)
	}
	if _, err := r.Create("principalA", "conv-idle-1"); err != nil {
		t.Fatalf("create idle 1: %v", err)
	}
	clock.Advance(2000) // beyond TTL: everything idle expires
	r.mu.Lock()
	evicted := r.evictLocked()
	r.mu.Unlock()
	if evicted < 1 {
		t.Errorf("expected idle entries to evict, evicted=%d", evicted)
	}
	if got := r.Lookup("principalA", "conv-active"); got != sidKeep {
		t.Errorf("active mapping evicted: lookup = %q, want %q", got, sidKeep)
	}
	if got := r.Lookup("principalA", "conv-idle-1"); got != "" {
		t.Errorf("expired idle mapping survived: %q", got)
	}
	// LRU bound: idle entries beyond maxIdle=1 evict oldest-first.
	if _, err := r.Create("principalA", "conv-idle-2"); err != nil {
		t.Fatalf("create idle 2: %v", err)
	}
	if _, err := r.Create("principalA", "conv-idle-3"); err != nil {
		t.Fatalf("create idle 3: %v", err)
	}
	if got := r.Lookup("principalA", "conv-idle-2"); got != "" {
		t.Errorf("LRU-oldest idle mapping survived the bound: %q", got)
	}
	if got := r.Lookup("principalA", "conv-idle-3"); got == "" {
		t.Errorf("newest idle mapping was evicted despite the bound")
	}
}

// TestRegistryLeaseLifecycle pins explicit semantics: Reference on an
// unknown mapping fails, Release without a lease fails, Terminate with an
// active lease fails, and a terminated mapping is never resurrected by
// Create (the error names the termination).
func TestRegistryLeaseLifecycle(t *testing.T) {
	clock := newFakeClock(1762000000000)
	r, err := NewSessionRegistry(RegistryOptions{NowMs: clock.Now})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer r.Close()
	if err := r.Reference("p", "unknown"); err == nil {
		t.Errorf("Reference(unknown) succeeded, want error")
	}
	sid, err := r.Create("p", "conv-1")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := r.Release("p", "conv-1"); err == nil {
		t.Errorf("Release without a lease succeeded, want error")
	}
	if err := r.Reference("p", "conv-1"); err != nil {
		t.Fatalf("reference: %v", err)
	}
	if err := r.Terminate("p", "conv-1"); err == nil {
		t.Errorf("Terminate with an active lease succeeded, want error")
	}
	if err := r.Release("p", "conv-1"); err != nil {
		t.Fatalf("release: %v", err)
	}
	if err := r.Terminate("p", "conv-1"); err != nil {
		t.Fatalf("terminate: %v", err)
	}
	if got := r.Lookup("p", "conv-1"); got != "" {
		t.Errorf("terminated mapping still lookups as %q", got)
	}
	if _, err := r.Create("p", "conv-1"); err == nil {
		t.Errorf("Create after Terminate succeeded, want refusal")
	} else if !contains(err.Error(), sid) {
		t.Errorf("termination error %q does not name the terminated session id", err.Error())
	}
	stats := r.Stats()
	if stats.Terminated != 1 {
		t.Errorf("stats.Terminated = %d, want 1", stats.Terminated)
	}
}

// TestRegistrySingleOwnerOSLock pins the OS-lock single-owner rule: a second
// registry over the same state file fails to open while the first holds it,
// and succeeds after Close.
func TestRegistrySingleOwnerOSLock(t *testing.T) {
	path := tempStatePath(t)
	r1, err := NewSessionRegistry(RegistryOptions{Path: path})
	if err != nil {
		t.Fatalf("open first: %v", err)
	}
	if _, err := NewSessionRegistry(RegistryOptions{Path: path}); err == nil {
		t.Errorf("second registry over the same state file opened; single-owner violated")
	}
	r1.Close()
	r2, err := NewSessionRegistry(RegistryOptions{Path: path})
	if err != nil {
		t.Fatalf("reopen after close: %v", err)
	}
	r2.Close()
}

// TestRegistryDurableAtomicState pins the state file shape: valid JSON,
// version 1, entries with digests only (never a raw secret), and no temp
// file left behind after a clean write.
func TestRegistryDurableAtomicState(t *testing.T) {
	path := tempStatePath(t)
	r, err := NewSessionRegistry(RegistryOptions{Path: path})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := r.Create("principalA", "conv-1"); err != nil {
		t.Fatalf("create: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("state file unreadable: %v", err)
	}
	var state struct {
		Version int             `json:"version"`
		Entries []RegistryEntry `json:"entries"`
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatalf("state file is not valid JSON: %v", err)
	}
	if state.Version != 1 || len(state.Entries) != 1 {
		t.Fatalf("state = version %d, %d entries; want version 1, 1 entry", state.Version, len(state.Entries))
	}
	if state.Entries[0].Principal != "principalA" || state.Entries[0].Conversation != "conv-1" {
		t.Errorf("state entry = %+v, want the principal/conversation keys", state.Entries[0])
	}
	if _, err := os.Stat(path + registryTmpSuffix); err == nil {
		t.Errorf("temp state file left behind after clean write")
	}
}

// TestRegistryCorruptStateIsAnError pins that a corrupt state file is an
// error on open (never silently reset — session identity mappings are the
// plugin's primary identity store).
func TestRegistryCorruptStateIsAnError(t *testing.T) {
	path := tempStatePath(t)
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("seed corrupt state: %v", err)
	}
	if _, err := NewSessionRegistry(RegistryOptions{Path: path}); err == nil {
		t.Errorf("opening a corrupt state file succeeded, want error")
	}
}

// TestRegistryUnknownVersionIsAnError pins forward-safety: a state file with
// an unsupported version refuses to open rather than guessing.
func TestRegistryUnknownVersionIsAnError(t *testing.T) {
	path := tempStatePath(t)
	if err := os.WriteFile(path, []byte(`{"version":99,"entries":[]}`), 0o600); err != nil {
		t.Fatalf("seed state: %v", err)
	}
	if _, err := NewSessionRegistry(RegistryOptions{Path: path}); err == nil {
		t.Errorf("opening an unsupported state version succeeded, want error")
	}
}

// TestRegistryRequiresIdentities pins the input boundary: empty principal or
// conversation never mints.
func TestRegistryRequiresIdentities(t *testing.T) {
	r, err := NewSessionRegistry(RegistryOptions{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer r.Close()
	for _, tc := range [][2]string{{"", "conv"}, {"p", ""}, {"  ", "conv"}, {"p", "  "}} {
		if _, err := r.Create(tc[0], tc[1]); err == nil {
			t.Errorf("Create(%q, %q) succeeded, want error", tc[0], tc[1])
		}
	}
}

func contains(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}

// TestRegistryMintedIDsMatchSourceVectors pins end-to-end that registry
// minting goes through the exact native algorithm: with the id generator
// driven to the pinned (ts, counter) state, the minted id equals the known
// real id prefix (the six audited ids all solve to counter=1, fresh process).
func TestRegistryMintedIDsMatchSourceVectors(t *testing.T) {
	clock := newFakeClock(1793526083674) // the first audited id's solved ts
	r, err := NewSessionRegistry(RegistryOptions{NowMs: clock.Now})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer r.Close()
	sid, err := r.Create("principalA", "conv-1")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Fresh-process first mint at that ms is counter=1 -> the audited real
	// id's exact time part.
	if got := fmt.Sprintf("%.16s", sid); got != "ses_e6983cfa5ffe" {
		t.Errorf("minted id prefix = %q, want ses_e6983cfa5ffe (exact native vector)", got)
	}
}
