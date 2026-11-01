package opencode

import (
	"path/filepath"
	"testing"
	"time"
)

func persistentShutdownHandler(t *testing.T, transport Transport) (*Handler, string) {
	t.Helper()
	h := newTestHandler(t, transport)
	path := filepath.Join(t.TempDir(), "sessions.json")
	if err := h.Configure([]byte(testConfigYAML + "\nsession_state_path: " + path + "\n")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Shutdown)
	return h, path
}

func TestShutdownReleasesIdleRegistryAndRefusesFurtherCalls(t *testing.T) {
	h, path := persistentShutdownHandler(t, nil)
	id, err := h.registry.Create("p", "c")
	if err != nil {
		t.Fatal(err)
	}
	h.Shutdown()
	h.Shutdown()
	if !h.ShutdownComplete() {
		t.Fatal("idle shutdown did not finish")
	}
	for _, method := range []string{"auth.parse", "executor.execute", "plugin.reconfigure"} {
		if _, err := h.HandleMethod(method, nil); statusOf(err) != 503 {
			t.Fatalf("closed handler accepted %s: %v", method, err)
		}
	}
	if statusOf(h.Configure([]byte(testConfigYAML))) != 503 {
		t.Fatal("closed handler reconfigured")
	}
	other, err := NewSessionRegistry(RegistryOptions{Path: path, NowMs: h.nowMs})
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if other.Lookup("p", "c") != id {
		t.Fatal("shutdown changed durable identity")
	}
}

func TestShutdownKeepsOwnershipUntilCancelledPumpReleasesLease(t *testing.T) {
	chunks := make(chan StreamChunk)
	transport := &fakeTransport{streamResult: StreamResult{StatusCode: 200, Chunks: chunks}}
	h, path := persistentShutdownHandler(t, transport)
	if _, err := h.HandleMethod("executor.execute_stream", configLifecycleRequest(true)); err != nil {
		t.Fatal(err)
	}
	principal := "caller:" + fixtureCallerScope
	id := h.registry.Lookup(principal, "fixture-conversation")
	h.Shutdown()
	if h.ShutdownComplete() {
		t.Fatal("shutdown released live pump ownership")
	}
	if other, err := NewSessionRegistry(RegistryOptions{Path: path, NowMs: h.nowMs}); err == nil {
		other.Close()
		t.Fatal("second owner admitted during drain")
	}
	if _, err := h.HandleMethod("executor.execute", configLifecycleRequest(false)); statusOf(err) != 503 {
		t.Fatal("draining handler admitted more traffic")
	}
	// The real host cancels/closes its HTTP resources before the shutdown RPC.
	close(chunks)
	waitFor(t, h.ShutdownComplete)
	if !h.ShutdownComplete() {
		t.Fatal("cancelled pump did not finish shutdown")
	}
	other, err := NewSessionRegistry(RegistryOptions{Path: path, NowMs: h.nowMs})
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if other.Lookup(principal, "fixture-conversation") != id || other.Stats().Active != 0 {
		t.Fatal("lease release was not persisted before handoff")
	}
}

func TestShutdownDrainsSynchronousDispatch(t *testing.T) {
	transport := &blockingConfigTransport{started: make(chan struct{}), resume: make(chan struct{})}
	h, path := persistentShutdownHandler(t, transport)
	dispatchDone := make(chan error, 1)
	go func() {
		_, err := h.HandleMethod("executor.execute", configLifecycleRequest(false))
		dispatchDone <- err
	}()
	select {
	case <-transport.started:
	case <-time.After(time.Second):
		t.Fatal("dispatch did not start")
	}
	shutdownDone := make(chan struct{})
	go func() { h.Shutdown(); close(shutdownDone) }()
	waitFor(t, h.shutdownRequested.Load)
	if h.ShutdownComplete() {
		t.Fatal("shutdown did not drain synchronous request")
	}
	close(transport.resume)
	if err := <-dispatchDone; err != nil {
		t.Fatal(err)
	}
	select {
	case <-shutdownDone:
	case <-time.After(time.Second):
		t.Fatal("shutdown stuck after dispatch")
	}
	other, err := NewSessionRegistry(RegistryOptions{Path: path, NowMs: h.nowMs})
	if err != nil {
		t.Fatal(err)
	}
	other.Close()
}
