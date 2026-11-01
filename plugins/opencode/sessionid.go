package opencode

import (
	"crypto/rand"
	"fmt"
	"sync"
	"time"
)

// Native source pins for this file (see SOURCE-PINS.md):
//   - packages/schema/src/identifier.ts (descending()/create()):
//     byte-identical in the pinned 2.0.32 / 2.1.4 / 2.2.5 trees (verified by
//     diff of the file across the three archives)
//   - packages/schema/src/session-id.ts (SessionID.create: "ses_" + descending())
//
// This is an EXACT port of the native descending identifier algorithm: the
// real bit ordering (bit-inverted millisecond*4096+counter, low 48 bits as
// six big-endian hex bytes), the native per-process counter semantics, and
// the 62-character random alphabet (not random hex). The random tail uses
// crypto/rand on the Go side, matching the native crypto.getRandomValues
// entropy source class. It does not reproduce the native JS module's global
// mutable lastTimestamp/counter across separate plugin processes; it holds
// them per-process in this package, like one native runtime process.

const (
	// identifierLength is the native body length (identifier.ts: length = 26).
	identifierLength = 26
	// identifierChars is the native 62-char alphabet (identifier.ts: chars).
	// Order is the native one: digits, uppercase, lowercase.
	identifierChars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
)

// idGenState reproduces the native module state: lastTimestamp/counter are
// global to the generating process and shared across descending()/ascending().
type idGenState struct {
	mu            sync.Mutex
	lastTimestamp int64
	counter       int64
}

var idGen idGenState

// set mirrors the native module for tests: reset to the pristine state.
func (g *idGenState) reset() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.lastTimestamp = 0
	g.counter = 0
}

// identifierTimeParts is the deterministic core of native create() for the
// six hex time bytes. timestamp is epoch milliseconds; counter advances once
// per call, resetting when the timestamp moves (identifier.ts create()).
func (g *idGenState) identifierTimeParts(descending bool, timestamp int64) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	if timestamp != g.lastTimestamp {
		g.lastTimestamp = timestamp
		g.counter = 0
	}
	g.counter++

	// const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
	current := uint64(timestamp)*0x1000 + uint64(g.counter)
	// const value = descending ? ~current : current
	value := current
	if descending {
		value = ^value
	}
	// six bytes, big-endian, from bit 40 down to bit 0 (48 bits total)
	var out [6]byte
	for index := 0; index < 6; index++ {
		shift := uint(40 - 8*index)
		out[index] = byte((value >> shift) & 0xff)
	}
	const hexDigits = "0123456789abcdef"
	var hex [12]byte
	for i, b := range out {
		hex[i*2] = hexDigits[b>>4]
		hex[i*2+1] = hexDigits[b&0x0f]
	}
	return string(hex[:])
}

// randomTail produces the native random segment: length-12 = 14 bytes, each
// mapped through chars[byte % 62] (identifier.ts: crypto.getRandomValues +
// byte % 62). crypto/rand is the CSPRNG analogue of getRandomValues.
func randomTail(n int) (string, error) {
	bytes := make([]byte, n)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("opencode session id random segment failed: %w", err)
	}
	out := make([]byte, n)
	for i, b := range bytes {
		out[i] = identifierChars[int(b)%62]
	}
	return string(out), nil
}

// DescendingIdentifier ports native identifier.ts descending() exactly:
// "ses_"-less body = 12 hex time chars + 14 alphabet chars, with the native
// per-process timestamp/counter state. timestampMs <= 0 means Date.now()
// (the native default parameter).
func DescendingIdentifier(timestampMs int64) (string, error) {
	if timestampMs <= 0 {
		timestampMs = time.Now().UnixMilli()
	}
	timePart := idGen.identifierTimeParts(true, timestampMs)
	tail, err := randomTail(identifierLength - 12)
	if err != nil {
		return "", err
	}
	return timePart + tail, nil
}

// AscendingIdentifier ports native identifier.ts ascending() (create(false)).
// SessionID.create uses descending(); ascending exists for parity and tests.
func AscendingIdentifier(timestampMs int64) (string, error) {
	if timestampMs <= 0 {
		timestampMs = time.Now().UnixMilli()
	}
	timePart := idGen.identifierTimeParts(false, timestampMs)
	tail, err := randomTail(identifierLength - 12)
	if err != nil {
		return "", err
	}
	return timePart + tail, nil
}

// NewSessionID is native SessionID.create (session-id.ts): "ses_" +
// descending(). timestampMs <= 0 uses the current time.
func NewSessionID(timestampMs int64) (string, error) {
	body, err := DescendingIdentifier(timestampMs)
	if err != nil {
		return "", err
	}
	return "ses_" + body, nil
}
