package registry

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"regexp"
	"sort"
	"sync"
	"time"
)

type BillingPolicy string

const (
	BillingFree    BillingPolicy = "FREE"
	BillingSub     BillingPolicy = "SUB"
	BillingPaid    BillingPolicy = "PAID"
	BillingUnknown BillingPolicy = "UNKNOWN"
)

func ValidBillingPolicy(p BillingPolicy) bool {
	return p == BillingFree || p == BillingSub || p == BillingPaid
}
func (p BillingPolicy) Allows(class BillingPolicy) bool {
	return p == BillingPaid || (p == BillingSub && (class == BillingFree || class == BillingSub)) || (p == BillingFree && class == BillingFree)
}
func RestrictBilling(p BillingPolicy, free bool) BillingPolicy {
	if free {
		return BillingFree
	}
	if !ValidBillingPolicy(p) {
		return BillingSub
	}
	return p
}

var RoutingID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func NewRoutingID() string {
	var b [16]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b[:])
}

type SessionPolicy struct {
	Policy  BillingPolicy `json:"policy"`
	Version uint64        `json:"version"`
}
type routingSession struct {
	Root     string
	Parent   string
	Updated  time.Time
	Policies map[string]SessionPolicy
}
type RoutingEvent struct {
	RequestID     string        `json:"request_id"`
	PromptID      string        `json:"prompt_id,omitempty"`
	Session       string        `json:"session"`
	ParentSession string        `json:"parent_session,omitempty"`
	Profile       string        `json:"profile"`
	Kind          string        `json:"kind"`
	Agent         string        `json:"agent,omitempty"`
	ParentRequest string        `json:"parent_request_id,omitempty"`
	Policy        BillingPolicy `json:"policy"`
	PolicyVersion uint64        `json:"policy_version"`
	BillingClass  BillingPolicy `json:"billing_class"`
	State         string        `json:"state"`
	Requested     string        `json:"requested_model,omitempty"`
	Resolved      string        `json:"resolved_model,omitempty"`
	Provider      string        `json:"provider,omitempty"`
	Started       time.Time     `json:"started_at"`
	Selected      *time.Time    `json:"selected_at,omitempty"`
	Completed     *time.Time    `json:"completed_at,omitempty"`
	Status        int           `json:"http_status,omitempty"`
}
type RoutingStore struct {
	mu       sync.Mutex
	sessions map[string]*routingSession
	events   map[string][]*RoutingTrace
	now      func() time.Time
}

func NewRoutingStore() *RoutingStore {
	return &RoutingStore{sessions: map[string]*routingSession{}, events: map[string][]*RoutingTrace{}, now: time.Now}
}

var DefaultRoutingStore = NewRoutingStore()

func routingKey(identity, session string) string { return identity + "\x00" + session }
func (s *RoutingStore) sessionLocked(identity, session, parent string) (*routingSession, error) {
	now := s.now()
	for k, v := range s.sessions {
		if now.Sub(v.Updated) > 24*time.Hour {
			delete(s.sessions, k)
			delete(s.events, k)
		}
	}
	key := routingKey(identity, session)
	if v := s.sessions[key]; v != nil {
		if parent != "" && v.Parent != parent {
			return nil, errors.New("session parent differs")
		}
		v.Updated = now
		root := s.sessions[routingKey(identity, v.Root)]
		if root == nil {
			return nil, errors.New("parent session expired")
		}
		root.Updated = now
		return v, nil
	}
	if len(s.sessions) >= 4096 {
		return nil, errors.New("session capacity reached")
	}
	n := 0
	for k := range s.sessions {
		if len(k) > len(identity) && k[:len(identity)+1] == identity+"\x00" {
			n++
		}
	}
	if n >= 128 {
		return nil, errors.New("identity session capacity reached")
	}
	root := session
	if parent != "" {
		v := s.sessions[routingKey(identity, parent)]
		if v == nil {
			return nil, errors.New("unknown parent session")
		}
		root = v.Root
		v.Updated = now
	}
	v := &routingSession{Root: root, Parent: parent, Updated: now, Policies: map[string]SessionPolicy{}}
	s.sessions[key] = v
	return v, nil
}

type BillingAdmission struct {
	Identity, Session, Parent string
	Policies                  map[string]SessionPolicy
	Store                     *RoutingStore
}

func (s *RoutingStore) Capture(identity, session, parent string) (*BillingAdmission, error) {
	a := &BillingAdmission{Identity: identity, Session: session, Parent: parent, Policies: map[string]SessionPolicy{}, Store: s}
	if session == "" {
		if parent != "" {
			return nil, errors.New("session required")
		}
		return a, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	v, e := s.sessionLocked(identity, session, parent)
	if e != nil {
		return nil, e
	}
	a.Parent = v.Parent
	for k, p := range s.sessions[routingKey(identity, v.Root)].Policies {
		a.Policies[k] = p
	}
	return a, nil
}
func (a *BillingAdmission) Policy(profile string) SessionPolicy {
	if a != nil {
		if p, ok := a.Policies[profile]; ok {
			return p
		}
	}
	return SessionPolicy{Policy: BillingSub}
}
func (s *RoutingStore) Set(a *BillingAdmission, profile string, policy BillingPolicy) (SessionPolicy, error) {
	if a == nil || a.Session == "" || !ValidBillingPolicy(policy) {
		return SessionPolicy{}, errors.New("session and valid policy required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	v, e := s.sessionLocked(a.Identity, a.Session, a.Parent)
	if e != nil {
		return SessionPolicy{}, e
	}
	root := s.sessions[routingKey(a.Identity, v.Root)]
	p, ok := root.Policies[profile]
	if !ok {
		p.Policy = BillingSub
	}
	if p.Policy != policy {
		p.Version++
		p.Policy = policy
	}
	root.Policies[profile] = p
	return p, nil
}
func (s *RoutingStore) Events(a *BillingAdmission, profile string) []RoutingEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []RoutingEvent{}
	if a == nil || a.Session == "" {
		return out
	}
	session := s.sessions[routingKey(a.Identity, a.Session)]
	if session == nil {
		return out
	}
	for key, rows := range s.events {
		v := s.sessions[key]
		if v == nil || v.Root != session.Root || len(key) <= len(a.Identity) || key[:len(a.Identity)+1] != a.Identity+"\x00" {
			continue
		}
		for _, t := range rows {
			e := t.Snapshot()
			if e.Profile == profile {
				out = append(out, e)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Started.Before(out[j].Started) })
	if len(out) > 128 {
		out = out[len(out)-128:]
	}
	return out
}

type RoutingTrace struct {
	mu    sync.Mutex
	Event RoutingEvent
}

func (t *RoutingTrace) Snapshot() RoutingEvent { t.mu.Lock(); defer t.mu.Unlock(); return t.Event }
func (t *RoutingTrace) Configure(profile, model string, p SessionPolicy, free bool) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.Event.Profile = profile
	t.Event.Requested = model
	t.Event.Policy = RestrictBilling(p.Policy, free)
	t.Event.PolicyVersion = p.Version
}
func (t *RoutingTrace) Select(class BillingPolicy, model, provider string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now().UTC()
	t.Event.BillingClass = class
	t.Event.Resolved = model
	t.Event.Provider = provider
	t.Event.Selected = &now
	t.Event.State = "in_flight"
}
func (t *RoutingTrace) Complete(status int, canceled bool) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now().UTC()
	t.Event.Completed = &now
	t.Event.Status = status
	failed := t.Event.State == "attempt_failed"
	t.Event.State = "completed"
	if canceled {
		t.Event.State = "canceled"
	} else if status >= 400 || failed {
		t.Event.State = "failed"
	}
}
func (s *RoutingStore) Begin(a *BillingAdmission, event RoutingEvent) *RoutingTrace {
	event.RequestID = NewRoutingID()
	if event.PromptID == "" {
		event.PromptID = event.RequestID
	}
	event.Session = a.Session
	event.ParentSession = a.Parent
	event.Started = time.Now().UTC()
	event.BillingClass = BillingUnknown
	event.State = "awaiting_route"
	t := &RoutingTrace{Event: event}
	if a.Session != "" {
		s.mu.Lock()
		defer s.mu.Unlock()
		key := routingKey(a.Identity, a.Session)
		rows := s.events[key]
		if len(rows) >= 64 {
			rows = rows[len(rows)-63:]
		}
		s.events[key] = append(rows, t)
	}
	return t
}

type billingAdmissionKey struct{}
type routingTraceKey struct{}

func WithBillingAdmission(ctx context.Context, a *BillingAdmission) context.Context {
	return context.WithValue(ctx, billingAdmissionKey{}, a)
}
func BillingAdmissionFromContext(ctx context.Context) *BillingAdmission {
	a, _ := ctx.Value(billingAdmissionKey{}).(*BillingAdmission)
	return a
}
func WithRoutingTrace(ctx context.Context, t *RoutingTrace) context.Context {
	return context.WithValue(ctx, routingTraceKey{}, t)
}
func RoutingTraceFromContext(ctx context.Context) *RoutingTrace {
	t, _ := ctx.Value(routingTraceKey{}).(*RoutingTrace)
	return t
}
func InheritBillingContext(to, from context.Context) context.Context {
	if a := BillingAdmissionFromContext(from); a != nil {
		to = WithBillingAdmission(to, a)
	}
	if t := RoutingTraceFromContext(from); t != nil {
		to = WithRoutingTrace(to, t)
	}
	return to
}
func RequestBillingPolicy(ctx context.Context, profile string, free bool) SessionPolicy {
	p := BillingAdmissionFromContext(ctx).Policy(profile)
	p.Policy = RestrictBilling(p.Policy, free)
	return p
}

type dispatchBillingKey struct{}

func WithDispatchBilling(ctx context.Context, p BillingPolicy) context.Context {
	return context.WithValue(ctx, dispatchBillingKey{}, p)
}
func DispatchBilling(ctx context.Context) BillingPolicy {
	p, _ := ctx.Value(dispatchBillingKey{}).(BillingPolicy)
	if !ValidBillingPolicy(p) {
		return BillingSub
	}
	return p
}

func (t *RoutingTrace) AttemptFailed() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.Event.State = "attempt_failed"
}

type boundModelKey struct{}

func WithBoundModel(ctx context.Context) context.Context {
	return context.WithValue(ctx, boundModelKey{}, true)
}
func RequiresBoundModel(ctx context.Context) bool {
	v, _ := ctx.Value(boundModelKey{}).(bool)
	return v
}

type uncertainFeatureCostKey struct{}

func WithUncertainFeatureCost(ctx context.Context, on bool) context.Context {
	return context.WithValue(ctx, uncertainFeatureCostKey{}, on)
}
func UncertainFeatureCost(ctx context.Context) bool {
	v, _ := ctx.Value(uncertainFeatureCostKey{}).(bool)
	return v
}

func (t *RoutingTrace) AwaitRoute() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.Event.State = "awaiting_route"
	t.Event.BillingClass = BillingUnknown
	t.Event.Resolved = ""
	t.Event.Provider = ""
	t.Event.Selected = nil
}
