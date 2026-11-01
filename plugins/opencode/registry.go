package opencode

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The plugin-owned provider session registry.
//
// Scope honesty (this is a LOCAL plugin registry, not OpenCode internals):
// it does NOT claim parity with the native OpenCode DB, event bus, or
// Session.create persistence. Native Session.create is a local resource of
// the native runtime (project resolver + event bus + session store); this
// registry is the plugin's own durable mapping:
//
//	(principal, host conversation identity) -> minted OpenCode session id
//
// The principal and conversation keys come from the host's trusted executor
// metadata only:
//   - conversation: canonical_session_id (the host's unified session
//     identity, stamped by the host's own session-identity reconciliation)
//   - principal: the caller authorization digest (sha256 of the bearer,
//     the same convention the gateway uses for principal-scoped keys;
//     the raw secret is never stored or logged)
//
// The minted id is produced by the exact native SessionID.create algorithm
// (sessionid.go). The mapping is persistent (atomic+durable JSON state with
// an OS file lock for single ownership), survives restarts, partitions
// principals strictly, evicts inactive entries by bounded TTL/LRU, protects
// active leases from eviction, and exposes explicit create/reference/
// release/terminate semantics.

// RegistryEntryState is the lifecycle state of one mapping.
type RegistryEntryState string

const (
	// RegistryStateActive marks a mapping with a live lease (in-flight or
	// streaming dispatch). Active entries are never evicted.
	RegistryStateActive RegistryEntryState = "active"
	// RegistryStateIdle marks a mapping with no live lease.
	RegistryStateIdle RegistryEntryState = "idle"
	// RegistryStateTerminated marks a mapping explicitly terminated by the
	// operator/caller. Terminated entries are remembered (never silently
	// resurrected) until they age out of the retention window.
	RegistryStateTerminated RegistryEntryState = "terminated"
)

// RegistryEntry is one persisted (principal, conversation) -> session mapping.
type RegistryEntry struct {
	SessionID    string             `json:"session_id"`
	Principal    string             `json:"principal"` // digest, never the raw secret
	Conversation string             `json:"conversation"`
	State        RegistryEntryState `json:"state"`
	CreatedMs    int64              `json:"created_ms"`
	LastUsedMs   int64              `json:"last_used_ms"`
	Leases       int                `json:"leases"`
}

// RegistryStats summarizes the registry for diagnostics (bounded output).
type RegistryStats struct {
	Entries     int `json:"entries"`
	Active      int `json:"active"`
	Terminated  int `json:"terminated"`
	LastEvicted int `json:"last_evicted"`
}

// SessionRegistry is the persistent (principal, conversation) -> session id
// mapping. All methods are safe for concurrent use.
type SessionRegistry struct {
	mu       sync.Mutex
	path     string // empty => in-memory only (tests)
	nowMs    NowMs
	ttlMs    int64
	maxIdle  int
	entries  map[string]*RegistryEntry // key: principal + "\x00" + conversation
	order    []string                  // LRU order, oldest first
	lockFile *os.File                  // held OS lock (single registry owner)
	closed   bool
	failure  error // uncertain persistence is terminal until a fresh locked open
}

// RegistryOptions configures a SessionRegistry.
type RegistryOptions struct {
	// Path is the state file. Empty means in-memory (state lost on exit;
	// for tests only).
	Path string
	// NowMs is the clock; defaults to wall time.
	NowMs NowMs
	// IdleTTLMS is how long an idle mapping is retained. Default: 7 days.
	IdleTTLMS int64
	// MaxIdleEntries bounds the LRU. Default: 1024.
	MaxIdleEntries int
}

const (
	defaultIdleTTLMS   = int64(7 * 24 * time.Hour / time.Millisecond)
	defaultMaxIdle     = 1024
	registryLockSuffix = ".lock"
	registryTmpSuffix  = ".tmp"
)

// NewSessionRegistry opens (or initializes) the persistent registry. The
// state file and its sidecar lock are created inside the same directory.
// A corrupt state file is an error, never silently reset (an operator must
// see and decide about lost session identity mappings).
func NewSessionRegistry(opts RegistryOptions) (*SessionRegistry, error) {
	if opts.NowMs == nil {
		opts.NowMs = func() int64 { return time.Now().UnixMilli() }
	}
	if opts.IdleTTLMS <= 0 {
		opts.IdleTTLMS = defaultIdleTTLMS
	}
	if opts.MaxIdleEntries <= 0 {
		opts.MaxIdleEntries = defaultMaxIdle
	}
	r := &SessionRegistry{
		path:    opts.Path,
		nowMs:   opts.NowMs,
		ttlMs:   opts.IdleTTLMS,
		maxIdle: opts.MaxIdleEntries,
		entries: map[string]*RegistryEntry{},
		order:   []string{},
	}
	if r.path == "" {
		return r, nil
	}
	if err := r.acquireLock(); err != nil {
		return nil, err
	}
	if err := r.load(); err != nil {
		r.releaseLock()
		return nil, err
	}
	return r, nil
}

// Close releases the OS lock. The state file remains.
func (r *SessionRegistry) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	r.releaseLock()
}

func (r *SessionRegistry) acquireLock() error {
	dir := filepath.Dir(r.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("opencode session registry cannot create state dir: %w", err)
	}
	lock, err := os.OpenFile(r.path+registryLockSuffix, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("opencode session registry cannot open lock: %w", err)
	}
	if err := lockFileExclusive(lock); err != nil {
		lock.Close()
		return fmt.Errorf("opencode session registry is already owned by another process: %w", err)
	}
	r.lockFile = lock
	return nil
}

func (r *SessionRegistry) releaseLock() {
	if r.lockFile != nil {
		unlockFile(r.lockFile)
		r.lockFile.Close()
		r.lockFile = nil
	}
}

func (r *SessionRegistry) key(principal, conversation string) string {
	return strings.TrimSpace(principal) + "\x00" + strings.TrimSpace(conversation)
}

func (r *SessionRegistry) readyLocked() error {
	if r.closed {
		return fmt.Errorf("opencode session registry is closed")
	}
	if r.failure != nil {
		return fmt.Errorf("opencode session registry requires recovery after persistence failure: %w", r.failure)
	}
	return nil
}

// load reads the state file. Absent file = fresh registry.
func (r *SessionRegistry) load() error {
	raw, err := os.ReadFile(r.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("opencode session registry state unreadable: %w", err)
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return fmt.Errorf("opencode session registry state is empty/corrupt")
	}
	var state struct {
		Version int             `json:"version"`
		Entries []RegistryEntry `json:"entries"`
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return fmt.Errorf("opencode session registry state is corrupt (delete %s only after deciding about lost mappings): %w", r.path, err)
	}
	if state.Version != 1 {
		return fmt.Errorf("opencode session registry state version %d is unsupported", state.Version)
	}
	now := r.nowMs()
	ids := map[string]bool{}
	recovered := false
	for i := range state.Entries {
		entry := state.Entries[i]
		if !ValidSessionID(entry.SessionID) || entry.SessionID != strings.TrimSpace(entry.SessionID) ||
			strings.TrimSpace(entry.Principal) == "" || strings.TrimSpace(entry.Conversation) == "" ||
			strings.ContainsRune(entry.Principal, '\x00') || strings.ContainsRune(entry.Conversation, '\x00') ||
			entry.CreatedMs <= 0 || entry.LastUsedMs < entry.CreatedMs || entry.Leases < 0 {
			return fmt.Errorf("opencode session registry contains invalid entry")
		}
		key := r.key(entry.Principal, entry.Conversation)
		if _, duplicate := r.entries[key]; duplicate || ids[entry.SessionID] {
			return fmt.Errorf("opencode session registry contains duplicate identity")
		}
		ids[entry.SessionID] = true
		switch entry.State {
		case RegistryStateActive:
			if entry.Leases == 0 {
				return fmt.Errorf("opencode active registry entry has no lease")
			}
			// The OS lock proves the old owner is gone. Its dispatch leases
			// cannot survive process death; retain identity, start a new idle TTL.
			entry.Leases, entry.State, entry.LastUsedMs = 0, RegistryStateIdle, now
			recovered = true
		case RegistryStateIdle, RegistryStateTerminated:
			if entry.Leases != 0 {
				return fmt.Errorf("opencode inactive registry entry has leases")
			}
		default:
			return fmt.Errorf("opencode session registry contains invalid state")
		}
		// A terminated entry older than the TTL has no remaining purpose.
		if entry.State == RegistryStateTerminated && now-entry.LastUsedMs > r.ttlMs {
			continue
		}
		r.entries[r.key(entry.Principal, entry.Conversation)] = &entry
		r.order = append(r.order, r.key(entry.Principal, entry.Conversation))
	}
	if r.evictLocked() > 0 {
		recovered = true
	}
	if recovered {
		return r.persistLocked()
	}
	return nil
}

// persist writes the state atomically (temp file + rename) and durably
// (fsync on the file and the directory). Caller holds r.mu.
func (r *SessionRegistry) persistLocked() (err error) {
	if err = r.readyLocked(); err != nil {
		return err
	}
	defer func() {
		if err != nil {
			r.failure = err
		}
	}()
	if r.path == "" {
		return nil
	}
	state := struct {
		Version int             `json:"version"`
		Entries []RegistryEntry `json:"entries"`
	}{Version: 1, Entries: make([]RegistryEntry, 0, len(r.entries))}
	for _, key := range r.order {
		if entry, ok := r.entries[key]; ok {
			state.Entries = append(state.Entries, *entry)
		}
	}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	tmp := r.path + registryTmpSuffix
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("opencode session registry cannot write state: %w", err)
	}
	if _, err := file.Write(raw); err != nil {
		file.Close()
		os.Remove(tmp)
		return fmt.Errorf("opencode session registry write failed: %w", err)
	}
	if err := syncFile(file); err != nil {
		file.Close()
		os.Remove(tmp)
		return fmt.Errorf("opencode session registry sync failed: %w", err)
	}
	if err := file.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, r.path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("opencode session registry rename failed: %w", err)
	}
	return syncDir(dirOf(r.path))
}

func dirOf(path string) string {
	if dir := filepath.Dir(path); dir != "" {
		return dir
	}
	return "."
}

// touch moves a key to the LRU tail. Caller holds r.mu.
func (r *SessionRegistry) touchLocked(key string) {
	for i, existing := range r.order {
		if existing == key {
			r.order = append(r.order[:i], r.order[i+1:]...)
			break
		}
	}
	r.order = append(r.order, key)
}

// evictLocked applies TTL to idle entries and the LRU bound. Returns the
// number evicted. Caller holds r.mu. Active leases are never evicted;
// terminated entries only age out by TTL.
func (r *SessionRegistry) evictLocked() int {
	now := r.nowMs()
	evicted := 0
	kept := r.order[:0]
	for _, key := range r.order {
		entry, ok := r.entries[key]
		if !ok {
			continue
		}
		expired := entry.State == RegistryStateIdle && now-entry.LastUsedMs > r.ttlMs
		expiredTerm := entry.State == RegistryStateTerminated && now-entry.LastUsedMs > r.ttlMs
		if expired || expiredTerm {
			delete(r.entries, key)
			evicted++
			continue
		}
		kept = append(kept, key)
	}
	r.order = kept
	// LRU bound: count only evictable (idle) entries; evict oldest-first.
	idleCount := 0
	for _, key := range r.order {
		if entry := r.entries[key]; entry != nil && entry.State == RegistryStateIdle {
			idleCount++
		}
	}
	for keyIdx := 0; idleCount > r.maxIdle && keyIdx < len(r.order); keyIdx++ {
		key := r.order[keyIdx]
		entry := r.entries[key]
		if entry == nil || entry.State != RegistryStateIdle {
			continue
		}
		delete(r.entries, key)
		r.order = append(r.order[:keyIdx], r.order[keyIdx+1:]...)
		keyIdx--
		idleCount--
		evicted++
	}
	return evicted
}

// Create resolves the mapping for (principal, conversation). Existing live
// mappings are returned unchanged (stable across restarts); a new session id
// is minted with the exact native algorithm only when none exists. A mapping
// explicitly terminated is never silently resurrected: it returns an error
// naming the termination.
func (r *SessionRegistry) Create(principal, conversation string) (string, error) {
	return r.resolve(principal, conversation, false)
}

// Acquire resolves and leases under one mutex: eviction cannot intervene
// between creation and dispatch ownership.
func (r *SessionRegistry) Acquire(principal, conversation string) (string, error) {
	return r.resolve(principal, conversation, true)
}

func (r *SessionRegistry) resolve(principal, conversation string, lease bool) (string, error) {
	principal = strings.TrimSpace(principal)
	conversation = strings.TrimSpace(conversation)
	if principal == "" || conversation == "" || strings.ContainsRune(principal, '\x00') || strings.ContainsRune(conversation, '\x00') {
		return "", fmt.Errorf("opencode session registry requires both principal and conversation identities")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.readyLocked(); err != nil {
		return "", err
	}
	r.evictLocked()
	key := r.key(principal, conversation)
	if entry, ok := r.entries[key]; ok {
		if entry.State == RegistryStateTerminated {
			return "", fmt.Errorf("opencode session %s for conversation %q was explicitly terminated; create a new conversation identity instead of reusing it", entry.SessionID, conversation)
		}
		entry.LastUsedMs = r.nowMs()
		if lease {
			entry.Leases++
			entry.State = RegistryStateActive
		}
		r.touchLocked(key)
		if err := r.persistLocked(); err != nil {
			return "", err
		}
		return entry.SessionID, nil
	}
	sessionID, err := NewSessionID(r.nowMs())
	if err != nil {
		return "", err
	}
	now := r.nowMs()
	r.entries[key] = &RegistryEntry{
		SessionID:    sessionID,
		Principal:    principal,
		Conversation: conversation,
		State:        RegistryStateIdle,
		CreatedMs:    now,
		LastUsedMs:   now,
	}
	r.touchLocked(key)
	if lease {
		r.entries[key].Leases = 1
		r.entries[key].State = RegistryStateActive
	}
	r.evictLocked()
	if err := r.persistLocked(); err != nil {
		return "", err
	}
	return sessionID, nil
}

// Reference marks a dispatch in flight for the mapping: the entry becomes
// active and is protected from eviction until Release. Unknown mappings are
// an error (Create first).
func (r *SessionRegistry) Reference(principal, conversation string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.readyLocked(); err != nil {
		return err
	}
	key := r.key(principal, conversation)
	entry, ok := r.entries[key]
	if !ok || entry.State == RegistryStateTerminated || (entry.State == RegistryStateIdle && r.nowMs()-entry.LastUsedMs > r.ttlMs) {
		return fmt.Errorf("opencode session registry has no live session for conversation %q", conversation)
	}
	entry.Leases++
	entry.State = RegistryStateActive
	entry.LastUsedMs = r.nowMs()
	return r.persistLocked()
}

// Release ends one dispatch lease. The mapping returns to idle (subject to
// TTL/LRU again). Releasing an idle/unknown mapping is an error.
func (r *SessionRegistry) Release(principal, conversation string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.readyLocked(); err != nil {
		return err
	}
	key := r.key(principal, conversation)
	entry, ok := r.entries[key]
	if !ok || entry.State == RegistryStateTerminated || entry.Leases <= 0 {
		return fmt.Errorf("opencode session registry cannot release conversation %q: no active lease", conversation)
	}
	entry.Leases--
	if entry.Leases == 0 {
		entry.State = RegistryStateIdle
		entry.LastUsedMs = r.nowMs()
		r.touchLocked(key)
	}
	r.evictLocked()
	return r.persistLocked()
}

// Terminate explicitly retires the mapping: the entry is marked terminated
// (never silently resurrected; a later Create for the same conversation
// fails with the termination named). Active leases block termination until
// released. Terminated entries age out of the state file by TTL.
func (r *SessionRegistry) Terminate(principal, conversation string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.readyLocked(); err != nil {
		return err
	}
	key := r.key(principal, conversation)
	entry, ok := r.entries[key]
	if !ok {
		return fmt.Errorf("opencode session registry has no session for conversation %q", conversation)
	}
	if entry.Leases > 0 {
		return fmt.Errorf("opencode session for conversation %q has %d active dispatch lease(s); release them before termination", conversation, entry.Leases)
	}
	entry.State = RegistryStateTerminated
	entry.LastUsedMs = r.nowMs()
	return r.persistLocked()
}

// Lookup returns the mapped session id without side effects ("reference"
// semantics for read paths). Empty string when absent.
func (r *SessionRegistry) Lookup(principal, conversation string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.readyLocked() != nil {
		return ""
	}
	entry, ok := r.entries[r.key(principal, conversation)]
	if !ok || entry.State == RegistryStateTerminated || (entry.State == RegistryStateIdle && r.nowMs()-entry.LastUsedMs > r.ttlMs) {
		return ""
	}
	return entry.SessionID
}

// Stats returns bounded diagnostics.
func (r *SessionRegistry) Stats() RegistryStats {
	r.mu.Lock()
	defer r.mu.Unlock()
	stats := RegistryStats{Entries: len(r.entries)}
	for _, entry := range r.entries {
		switch entry.State {
		case RegistryStateActive:
			stats.Active++
		case RegistryStateTerminated:
			stats.Terminated++
		}
	}
	return stats
}
