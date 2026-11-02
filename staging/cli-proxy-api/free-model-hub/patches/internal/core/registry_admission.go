package core

import "strings"

// registry_admission.go is a tokligence staging addition for the adopted
// free-model-hub build (source pin: Yousha-dev/free-model-hub
// 4d025efe8046af70327d80f75c5bd5ac6b4505af). Upstream has no admission filter;
// this addition keeps that default byte-for-byte and only takes effect when
// `plugins.configs.free-model-hub.allowed_vendors` / `blocked_vendors` are set.
//
// Purpose of this deployment: withhold selected vendor families at boot
// (OpenCode Zen / OpenCode Go while the public OpenCode lane returns 429, and
// duplicate OpenRouter while the native OpenRouter route is live) WITHOUT
// deleting any vendor code. Denied vendors are parked, not dropped; a later
// reconfigure can admit them again with no restart of the host.
//
// Narrow by design: no vendor behavior changes, no credential files are
// touched, and admission changes only affect which vendors are visible in
// this registry instance (model listing, credential claiming, keyless
// provisioning and management console all read through Vendors()/ByID()).

// ApplyAdmission re-resolves which registered vendors are active.
//
// allowed, when non-empty, is a strict allowlist: only those IDs stay active.
// blocked always excludes its IDs (it also applies when allowed is empty).
// Unlisted code stays parked inside the registry and can be re-admitted by a
// later ApplyAdmission call (e.g. a config reload) without re-registering.
//
// Call from the composition root only (see internal/app/vendor_admission.go);
// the method is a no-op for unknown IDs and keeps registry order otherwise.
func (r *Registry) ApplyAdmission(allowed, blocked []string) {
	if r == nil {
		return
	}
	allowedSet := admissionSet(allowed)
	blockedSet := admissionSet(blocked)
	r.mu.Lock()
	defer r.mu.Unlock()

	// Pass 1: park every active vendor that is no longer admitted.
	kept := make([]string, 0, len(r.order))
	for _, id := range r.order {
		if admissionDecisionLocked(id, allowedSet, blockedSet) {
			kept = append(kept, id)
			continue
		}
		if _, known := r.parked[id]; !known {
			r.parkedOrder = append(r.parkedOrder, id)
		}
		r.parked[id] = r.byID[id]
		delete(r.byID, id)
	}
	r.order = kept

	// Pass 2: restore parked vendors that are admitted again. Order entries
	// are appended deterministically (parkedOrder preserves parking order).
	restored := make([]string, 0, len(r.parkedOrder))
	for _, id := range r.parkedOrder {
		if _, stillParked := r.parked[id]; !stillParked {
			continue
		}
		if admissionDecisionLocked(id, allowedSet, blockedSet) {
			vendor := r.parked[id]
			delete(r.parked, id)
			r.byID[id] = vendor
			r.order = append(r.order, id)
			continue
		}
		restored = append(restored, id)
	}
	r.parkedOrder = restored
}

// Known reports whether the ID has ever been registered (active or parked).
//
// The composition root uses it to warn about allowlist entries that do not
// exist in this build instead of failing the config silently.
func (r *Registry) Known(id string) bool {
	if r == nil {
		return false
	}
	id = strings.ToLower(strings.TrimSpace(id))
	if id == "" {
		return false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if _, active := r.byID[id]; active {
		return true
	}
	_, parkedKnown := r.parked[id]
	return parkedKnown
}

// ParkedIDs lists the currently parked vendor IDs in parking order.
//
// Console/log queries only; parked vendors are invisible to Vendors(),
// ByID(), Resolve() and ParseCredential() until they are admitted again.
func (r *Registry) ParkedIDs() []string {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.parkedOrder))
	for _, id := range r.parkedOrder {
		if _, parked := r.parked[id]; parked {
			out = append(out, id)
		}
	}
	return out
}

func admissionSet(list []string) map[string]bool {
	set := map[string]bool{}
	for _, id := range list {
		trimmed := strings.ToLower(strings.TrimSpace(id))
		if trimmed != "" {
			set[trimmed] = true
		}
	}
	return set
}

// admissionDecisionLocked decides one ID; caller holds r.mu (write).
func admissionDecisionLocked(id string, allowedSet, blockedSet map[string]bool) bool {
	if blockedSet[id] {
		return false
	}
	if len(allowedSet) == 0 {
		return true
	}
	return allowedSet[id]
}
