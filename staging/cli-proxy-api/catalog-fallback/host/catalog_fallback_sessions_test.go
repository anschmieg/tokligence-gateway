package registry

import (
	"context"
	"testing"
	"time"
)

func TestSessionPolicyIsolationInheritanceAndImmutableAdmission(t *testing.T) {
	s := NewRoutingStore()
	a, e := s.Capture("alice", "one", "")
	if e != nil || a.Policy("coding").Policy != BillingSub {
		t.Fatal(e)
	}
	p, e := s.Set(a, "coding", BillingPaid)
	if e != nil || p.Version != 1 {
		t.Fatal(p, e)
	}
	if a.Policy("coding").Policy != BillingSub {
		t.Fatal("in-flight admission changed")
	}
	again, _ := s.Capture("alice", "one", "")
	if again.Policy("coding").Policy != BillingPaid || again.Policy("chat").Policy != BillingSub {
		t.Fatal("profile scope")
	}
	p2, _ := s.Set(again, "coding", BillingPaid)
	if p2.Version != p.Version {
		t.Fatal("set not idempotent")
	}
	child, e := s.Capture("alice", "child", "one")
	if e != nil || child.Policy("coding").Policy != BillingPaid {
		t.Fatal(e)
	}
	nested, e := s.Capture("alice", "nested", "child")
	if e != nil || nested.Policy("coding").Policy != BillingPaid {
		t.Fatal("nested inheritance", e)
	}
	nestedAgain, e := s.Capture("alice", "nested", "child")
	if e != nil || nestedAgain.Parent != "child" {
		t.Fatal("nested parent lost", e)
	}
	s.Set(again, "coding", BillingFree)
	childNext, _ := s.Capture("alice", "child", "one")
	if childNext.Policy("coding").Policy != BillingFree || child.Policy("coding").Policy != BillingPaid {
		t.Fatal("child inheritance/admission freeze")
	}
	stranger, _ := s.Capture("bob", "one", "")
	other, _ := s.Capture("alice", "two", "")
	if stranger.Policy("coding").Policy != BillingSub || other.Policy("coding").Policy != BillingSub {
		t.Fatal("identity/session leak")
	}
	if _, e := s.Capture("bob", "child", "private-parent"); e == nil {
		t.Fatal("foreign parent accepted")
	}
	ctx := WithBillingAdmission(context.Background(), again)
	if RequestBillingPolicy(ctx, "coding", true).Policy != BillingFree {
		t.Fatal("suffix widened")
	}
}
func TestSessionExpiryAndTelemetrySeparation(t *testing.T) {
	s := NewRoutingStore()
	now := time.Now()
	s.now = func() time.Time { return now }
	a, _ := s.Capture("id", "session", "")
	s.Set(a, "chat", BillingPaid)
	main := s.Begin(a, RoutingEvent{Kind: "main", PromptID: "p"})
	main.Configure("chat", "requested", a.Policy("chat"), false)
	aux := s.Begin(a, RoutingEvent{Kind: "compaction"})
	aux.Configure("chat", "small", a.Policy("chat"), false)
	aux.Select(BillingPaid, "small", "vendor")
	aux.Complete(200, false)
	if main.Snapshot().BillingClass != BillingUnknown || main.Snapshot().State != "awaiting_route" {
		t.Fatal("aux contaminated main")
	}
	main.Select(BillingFree, "resolved", "vendor")
	main.Complete(200, false)
	events := s.Events(a, "chat")
	if len(events) != 2 || events[0].BillingClass != BillingFree || events[1].BillingClass != BillingPaid {
		t.Fatal(events)
	}
	if len(s.Events(&BillingAdmission{Identity: "other", Session: "session"}, "chat")) != 0 {
		t.Fatal("telemetry leaked")
	}
	now = now.Add(25 * time.Hour)
	fresh, _ := s.Capture("id", "session", "")
	if fresh.Policy("chat").Policy != BillingSub || len(s.Events(fresh, "chat")) != 0 {
		t.Fatal("expired policy persisted")
	}
}
func TestSessionBillingAllowanceClassesAreExplicit(t *testing.T) {
	now := time.Now()
	r := NoChargeAllowance{Provider: "provider", AuthID: "account", SourceModels: []string{"source"}, Basis: "verified fixture", VerifiedUntil: now.Add(time.Hour).Format(time.RFC3339), NoPaidOverage: true}
	if NoChargeAllowanceClass([]NoChargeAllowance{r}, "provider", "account", "source", now) != BillingSub {
		t.Fatal("legacy receipt should be included, never free")
	}
	r.BillingClass = BillingFree
	if NoChargeAllowanceClass([]NoChargeAllowance{r}, "provider", "account", "source", now) != BillingFree {
		t.Fatal("verified free account not classified")
	}
	r.BillingClass = BillingPaid
	if ValidateNoChargeAllowances([]NoChargeAllowance{r}) == nil || NoChargeAllowanceValid([]NoChargeAllowance{r}, "provider", "account", "source", now) {
		t.Fatal("invalid no-charge billing proof admitted")
	}
}
