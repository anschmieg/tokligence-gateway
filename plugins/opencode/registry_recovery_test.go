package opencode

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestHandlerReleasesSessionOnEverySynchronousExit(t *testing.T) {
	for _, mode := range []string{"payload", "stream-id", "missing-transport", "transport-error", "stream-rejection"} {
		t.Run(mode, func(t *testing.T) {
			transport := &fakeTransport{doErr: fmt.Errorf("fixture transport failed"), streamResult: StreamResult{StatusCode: 429}}
			h := newTestHandler(t, transport)
			req := map[string]any{
				"Model": "beam-free", "AuthID": "fixture-owner", "StorageJSON": []byte(validCredential),
				"Metadata": map[string]any{"caller_scope": fixtureCallerScope, "canonical_session_id": "fixture-conversation"},
				"Payload":  []byte(`{"messages":[{"role":"user","content":"fixture"}]}`),
			}
			method := "executor.execute"
			switch mode {
			case "payload":
				req["Payload"] = []byte(`{`)
			case "stream-id":
				method = "executor.execute_stream"
				req["Stream"] = true
			case "missing-transport":
				h.transport = nil
			case "stream-rejection":
				method = "executor.execute_stream"
				req["Stream"] = true
				req["stream_id"] = "fixture-stream"
			}
			raw, _ := json.Marshal(req)
			if _, err := h.HandleMethod(method, raw); err == nil {
				t.Fatal("failure returned success")
			}
			if h.registry.Stats().Active != 0 {
				t.Fatal("synchronous failure leaked registry lease")
			}
			if mode == "stream-rejection" && transport.closed != 1 {
				t.Fatal("rejected upstream stream was not closed")
			}
		})
	}
}

func TestRegistryCrashLeaseRecovery(t *testing.T) {
	if path := os.Getenv("OPENCODE_REGISTRY_CRASH_FIXTURE"); path != "" {
		r, err := NewSessionRegistry(RegistryOptions{Path: path})
		if err != nil {
			t.Fatal(err)
		}
		id, err := r.Acquire("p", "conversation")
		if err != nil {
			t.Fatal(err)
		}
		fmt.Println(id)
		time.Sleep(time.Minute)
		return
	}
	path := tempStatePath(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRegistryCrashLeaseRecovery$")
	cmd.Env = append(os.Environ(), "OPENCODE_REGISTRY_CRASH_FIXTURE="+path)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() {
		t.Fatal("child did not persist lease")
	}
	id := scanner.Text()
	if !ValidSessionID(id) {
		t.Fatalf("invalid child identity %q", id)
	}
	if other, err := NewSessionRegistry(RegistryOptions{Path: path}); err == nil {
		other.Close()
		t.Fatal("concurrent owner admitted")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	r, err := NewSessionRegistry(RegistryOptions{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if r.Stats().Active != 0 || r.Lookup("p", "conversation") != id {
		t.Fatal("dead lease survived or identity changed")
	}
	if err := r.Terminate("p", "conversation"); err != nil {
		t.Fatal(err)
	}
}

func TestRegistryAcquireProtectsAgainstConcurrentEviction(t *testing.T) {
	r, err := NewSessionRegistry(RegistryOptions{MaxIdleEntries: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	id, err := r.Acquire("p", "held")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			conversation := fmt.Sprint(i)
			if _, err := r.Acquire("p", conversation); err != nil {
				t.Error(err)
				return
			}
			if err := r.Release("p", conversation); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if r.Lookup("p", "held") != id {
		t.Fatal("leased identity evicted")
	}
	if err := r.Release("p", "held"); err != nil {
		t.Fatal(err)
	}
	if r.Stats().Entries > 1 {
		t.Fatal("release did not enforce idle limit")
	}
}

func TestRegistryExpiredReuseAndClosedOwner(t *testing.T) {
	clock := newFakeClock(1762000000000)
	r, err := NewSessionRegistry(RegistryOptions{NowMs: clock.Now, IdleTTLMS: 10})
	if err != nil {
		t.Fatal(err)
	}
	old, _ := r.Create("p", "c")
	clock.Advance(11)
	if r.Lookup("p", "c") != "" {
		t.Fatal("lookup exposed expired session")
	}
	fresh, err := r.Acquire("p", "c")
	if err != nil || fresh == old {
		t.Fatalf("TTL not applied to reuse: %v", err)
	}
	r.Close()
	if _, err := r.Acquire("p", "c"); err == nil {
		t.Fatal("closed owner accepted acquire")
	}
	if err := r.Release("p", "c"); err == nil {
		t.Fatal("closed owner accepted release")
	}
}

func TestRegistryPersistenceFailureStopsDispatchUntilReopen(t *testing.T) {
	path := tempStatePath(t)
	r, err := NewSessionRegistry(RegistryOptions{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	id, err := r.Create("p", "old")
	if err != nil {
		t.Fatal(err)
	}
	// Deterministic disk write failure without changing directory permissions.
	if err := os.Mkdir(path+registryTmpSuffix, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Acquire("p", "new"); err == nil {
		t.Fatal("failed persistence acknowledged")
	}
	if err := os.Remove(path + registryTmpSuffix); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Acquire("p", "old"); err == nil {
		t.Fatal("uncertain owner resumed dispatch")
	}
	if r.Lookup("p", "old") != "" {
		t.Fatal("uncertain state exposed")
	}
	r.Close()
	fresh, err := NewSessionRegistry(RegistryOptions{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	if fresh.Lookup("p", "old") != id || fresh.Lookup("p", "new") != "" {
		t.Fatal("recovery changed committed state")
	}
}

func TestRegistryRejectsAmbiguousAndCorruptState(t *testing.T) {
	r, _ := NewSessionRegistry(RegistryOptions{})
	defer r.Close()
	if _, err := r.Acquire("a\x00b", "c"); err == nil {
		t.Fatal("ambiguous principal accepted")
	}
	if _, err := r.Acquire("a", "b\x00c"); err == nil {
		t.Fatal("ambiguous conversation accepted")
	}
	for i, raw := range []string{"", `{"version":1,"entries":[{"session_id":"invalid"}]}`} {
		path := filepath.Join(t.TempDir(), fmt.Sprint(i))
		if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if bad, err := NewSessionRegistry(RegistryOptions{Path: path}); err == nil {
			bad.Close()
			t.Fatal("corrupt state accepted")
		}
	}
}
