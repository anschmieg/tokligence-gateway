package tasks

import (
	"context"
	"testing"
	"time"
)

// Tests only the custom keepalive_enabled config gate; reuses the package's
// own fakeDeps test harness without touching upstream test suites.

func TestSchedulerStatusReportsKeepaliveEnabledDefault(t *testing.T) {
	deps := newFakeDeps(time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC))
	deps.cfg.KeepaliveEnabled = true
	s := New(deps)
	status := s.Status()
	if enabled, present := status["keepalive_enabled"]; !present || enabled != true {
		t.Fatalf("scheduler status keepalive_enabled = %v (present=%v), want true", enabled, present)
	}
}

func TestSchedulerStatusReportsKeepaliveDisabled(t *testing.T) {
	deps := newFakeDeps(time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC))
	deps.cfg = Config{KeepaliveEnabled: false}
	s := New(deps)
	status := s.Status()
	if enabled, present := status["keepalive_enabled"]; !present || enabled != false {
		t.Fatalf("scheduler status keepalive_enabled = %v (present=%v), want false", enabled, present)
	}
}

func TestDisabledSchedulerNeverRunsKeepalive(t *testing.T) {
	deps := newFakeDeps(time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC))
	deps.cfg = Config{KeepaliveEnabled: false}
	s := New(deps)
	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	// Default keepalive hour is 22; the disable gate must keep the loop parked
	// forever rather than waking at 22:00 to refresh foreign credentials.
	time.Sleep(100 * time.Millisecond)
	if deps.refreshSaves != 0 {
		t.Fatalf("disabled scheduler performed %d credential write-back(s)", deps.refreshSaves)
	}
	cancel()
	s.Stop()
	status := s.Status()
	if enabled, present := status["keepalive_enabled"]; !present || enabled != false {
		t.Fatalf("status keepalive_enabled after stop = %v (present=%v), want false", enabled, present)
	}
}
