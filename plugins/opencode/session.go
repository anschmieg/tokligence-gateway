package opencode

import (
	"regexp"
	"strings"
)

// Native source pins for this file (see SOURCE-PINS.md):
//   - session id shape: packages/schema/src/session-id.ts + identifier.ts
//     ("ses_" + descending(); the generator itself is ported exactly in
//     sessionid.go)
//   - affinity: packages/core/src/session/affinity.ts (SessionAffinity.get:
//     parentID ?? fork?.sessionID ?? id)
//   - inference header binding: packages/core/src/session/model-request.ts
//     (x-opencode-session-id: session.id; x-session-affinity/X-Session-Id/
//     x-opencode-session: affinity)
//
// Scope honesty (corrected per review): session.go previously asserted that
// the upstream "rejects a request whose session headers name a session no
// real client created" and that Session.create "requires the native runtime"
// — presented as if Session.create were a known remote API contract. It is
// not: native Session.create is a LOCAL resource of the native runtime
// (project resolver, event bus, session store), and no evidence in the
// pinned sources demonstrates an upstream API restriction on session header
// values. What the pinned sources actually establish is only the ID SHAPE
// and the header binding. This file therefore:
//   - validates the native session id shape (a ported reference behavior),
//   - does NOT claim the upstream rejects unknown/foreign session ids,
//   - does NOT claim native harness semantics beyond what the pinned source
//     files show.
// Whether the upstream enforces session-creation provenance is an open
// operational question; the registry (registry.go) removes the plugin's need
// to answer it by minting well-formed ids per conversation persistently.

// SessionIDPattern is the native session id shape from the pinned source:
// "ses_" + descending() where descending() (schema/src/identifier.ts,
// identical in 2.0.32/2.1.4/2.2.5) is 12 lowercase hex chars — six bytes of
// the bit-inverted millisecond/counter value, each byte padded to two hex
// digits — followed by 14 chars from the 62-char alphabet (26 - 12 random
// bytes). Total body: 26 characters.
var SessionIDPattern = regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`)

// AffinityPattern is the native affinity variant model-request.ts
// recognizes for promptCacheKey extraction (^ses_[0-9a-f]{64}$).
var AffinityPattern = regexp.MustCompile(`^ses_[0-9a-f]{64}$`)

// ValidSessionID reports whether id has the native session id shape. This is
// a shape check ported from the pinned source; it is not a claim that the id
// was created by any particular client or runtime.
func ValidSessionID(id string) bool {
	return SessionIDPattern.MatchString(strings.TrimSpace(id))
}

// ValidAffinity reports whether id is a native affinity value: either the
// session id shape or the 64-hex variant model-request.ts recognizes.
func ValidAffinity(id string) bool {
	id = strings.TrimSpace(id)
	return SessionIDPattern.MatchString(id) || AffinityPattern.MatchString(id)
}

// SessionIdentity resolves the OpenCode session identity for one request
// from caller-supplied values. Precedence (pinned model-request.ts binding):
// the session id sets x-opencode-session-id; the affinity (SessionAffinity.
// get) sets the affinity headers. With no caller affinity, the session id is
// its own affinity root (affinity.ts: a session with no parent/fork is its
// own affinity).
//
// This function is pure: it validates shapes and applies the native binding
// rules. It no longer fails when values are absent — dispatch identity is
// resolved by the registry-backed path in the handler (sessionForRequest).
func SessionIdentity(sessionID, affinity string) (string, string) {
	sessionID = strings.TrimSpace(sessionID)
	affinity = strings.TrimSpace(affinity)
	if sessionID != "" && ValidSessionID(sessionID) {
		if affinity == "" {
			affinity = sessionID
		}
		return sessionID, affinity
	}
	// A native-shaped affinity alone names the conversation's identity.
	if affinity != "" && ValidSessionID(affinity) {
		return affinity, affinity
	}
	// The 64-hex affinity variant is accepted for the affinity headers only;
	// it does not carry a session id shape.
	if affinity != "" && ValidAffinity(affinity) {
		return sessionID, affinity
	}
	return sessionID, affinity
}
