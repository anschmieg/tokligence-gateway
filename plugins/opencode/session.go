package opencode

import (
	"fmt"
	"regexp"
	"strings"
)

// Native source pins for this file (see SOURCE-PINS.md):
//   - session lifecycle: packages/core/src/session.ts (Session.create:
//     projects a SessionEvent.Created event into a durable session store
//     through the event bus, resolving a project/location first)
//   - session id: packages/schema/src/session-id.ts (SessionID.create:
//     "ses_" + descending() identifier)
//   - affinity: packages/core/src/session/affinity.ts (SessionAffinity.get:
//     parentID ?? fork?.sessionID ?? id)
//   - inference header binding: packages/core/src/session/model-request.ts
//     (x-opencode-session-id: session.id; x-session-affinity/X-Session-Id/
//     x-opencode-session: affinity)
//
// A native OpenCode session is a real database object created by the native
// runtime's event-sourced Session.create (it needs the native project
// resolver, event bus and session store — a CLIProxyAPI dynamic plugin has
// none of them, and adding a framework or sidecar is out of scope for this
// slice). The audited work additionally established that the Zen free tier
// rejects a request whose session headers name a session no real client
// created. This plugin therefore NEVER mints client-looking session ids.
// It only forwards identities that name an actually-created OpenCode session,
// supplied by the caller, and fails dispatch with a precise error otherwise.

// SessionIDPattern is the native session id shape from the pinned source:
// "ses_" + descending() where descending() (schema/src/identifier.ts,
// identical in 2.0.32/2.1.4/2.2.5) is 12 lowercase hex chars — six bytes of
// the bit-inverted millisecond/counter value, each byte padded to two hex
// digits — followed by 14 chars from the 62-char alphabet (26 - 12 random
// bytes). Total body: 26 characters.
//
// The known working sessions follow this shape exactly (for example
// ses_e6983cfa5ffejQiSHP0zl9KfzV). model-request.ts's promptCacheKey check
// additionally recognizes a 64-hex variant (^ses_[0-9a-f]{64}$) as an
// affinity value, so that shape is accepted as an affinity.
//
// Matching is intentionally shape-only: it never asserts an id was created
// by any client.
var SessionIDPattern = regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`)

// AffinityPattern is the native affinity variant model-request.ts
// recognizes for promptCacheKey extraction (^ses_[0-9a-f]{64}$).
var AffinityPattern = regexp.MustCompile(`^ses_[0-9a-f]{64}$`)

// ValidSessionID reports whether id has the native session id shape. A
// shape match is NOT proof of native creation — only a session the native
// runtime actually created is legitimate, and the plugin cannot verify
// creation; it relies on the operator-declared identity plus the upstream's
// own validation.
func ValidSessionID(id string) bool {
	return SessionIDPattern.MatchString(strings.TrimSpace(id))
}

// ValidAffinity reports whether id is a native affinity value: either the
// session id shape or the 64-hex variant model-request.ts recognizes.
func ValidAffinity(id string) bool {
	id = strings.TrimSpace(id)
	return SessionIDPattern.MatchString(id) || AffinityPattern.MatchString(id)
}

// SessionIdentityError is the precise dispatch failure raised when a request
// carries no identity naming an actually-created OpenCode session. The error
// names the exact gap so an operator can fix the configuration instead of
// the request silently minting a fabricated session.
type SessionIdentityError struct {
	ConversationID string
}

const sessionGapDetail = "the OpenCode free tier only serves a request whose x-opencode-session-id / x-session-affinity headers name a session a real OpenCode runtime created; native session creation (Session.create) requires the native project resolver, event bus and session store, which a CLIProxyAPI dynamic plugin cannot host, and this plugin does not mint client-looking session ids. Configure the gateway/client to send the conversation's actual OpenCode session id (host conversation metadata key canonical_session_id or a caller x-session-id/x-session-affinity header naming the created session), or run a native OpenCode runtime that creates the session and forwards its id"

func (e *SessionIdentityError) Error() string {
	return fmt.Sprintf(
		"opencode dispatch requires a native OpenCode session identity for conversation %q: %s",
		e.ConversationID, sessionGapDetail,
	)
}

// SessionIdentity resolves the OpenCode session identity for one request.
// The plugin accepts only identities the caller supplies that name a real
// OpenCode session; it never invents one. Caller-supplied values that carry
// a different namespace (the host's own "header:"-prefixed canonical ids,
// for instance) are rejected with the exact gap.
//
// When no session identity is present, dispatch fails with
// SessionIdentityError (never a fabricated session).
func SessionIdentity(conversationID, sessionID, affinity string) (string, string, error) {
	sessionID = strings.TrimSpace(sessionID)
	affinity = strings.TrimSpace(affinity)
	if sessionID != "" && ValidSessionID(sessionID) {
		if affinity == "" {
			affinity = sessionID
		}
		return sessionID, affinity, nil
	}
	// A valid affinity (session shape or the 64-hex variant) carries the
	// conversation's native identity; the session id derives from it only
	// when it has the session shape.
	if affinity != "" && ValidAffinity(affinity) {
		derived := sessionID
		if derived == "" && ValidSessionID(affinity) {
			derived = affinity
		}
		return derived, affinity, nil
	}
	// The values present (if any) are not native OpenCode identities: name
	// the gap precisely instead of passing a foreign identity upstream.
	return "", "", &SessionIdentityError{ConversationID: strings.TrimSpace(conversationID)}
}
