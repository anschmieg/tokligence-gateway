package catalogfallback

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fixtureRoundTripper func(*http.Request) (*http.Response, error)

func (f fixtureRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func fixtureLiveBody() string                                                   { return `{"models":{"lab/a":{}},"providers":{}}` }
func TestDraftLiveCacheRevalidateRestartAndOutageAge(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cache.json")
	step := 0
	client := &http.Client{Transport: fixtureRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != LiveCatalogURL {
			t.Fatal(r.URL)
		}
		step++
		switch step {
		case 1:
			return &http.Response{StatusCode: 200, Header: http.Header{"Etag": {`"v1"`}}, Body: io.NopCloser(strings.NewReader(fixtureLiveBody()))}, nil
		case 2:
			if r.Header.Get("If-None-Match") != `"v1"` {
				t.Fatal("lost validator")
			}
			return &http.Response{StatusCode: 304, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(""))}, nil
		default:
			return nil, errors.New("offline")
		}
	})}
	c := NewLiveCache(client)
	ctx := context.Background()
	data, fresh, err := c.Refresh(ctx, LiveCatalogURL, path, fixtureNow)
	if err != nil || !fresh {
		t.Fatal(fresh, err)
	}
	s, _ := DecodeModelsDev(data, fixtureNow)
	if !s.publishedAt.Equal(fixtureNow) {
		t.Fatal(s)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
	later := fixtureNow.Add(time.Hour)
	c = NewLiveCache(client) // actual disk restart, not just shared memory
	cached, ok := c.Cached(LiveCatalogURL, path, later)
	if !ok {
		t.Fatal("cache not bootstrapped")
	}
	s, _ = DecodeModelsDev(cached, later)
	if !s.publishedAt.Equal(fixtureNow) {
		t.Fatal("local read refreshed age")
	}
	data, fresh, err = c.Refresh(ctx, LiveCatalogURL, path, later)
	if err != nil || !fresh {
		t.Fatal(fresh, err)
	}
	s, _ = DecodeModelsDev(data, later)
	if !s.publishedAt.Equal(later) {
		t.Fatal("304 did not validate age")
	}
	raw, _ := os.ReadFile(path)
	data, fresh, err = c.Refresh(ctx, LiveCatalogURL, path, later.Add(24*time.Hour))
	if err != nil || fresh {
		t.Fatal(fresh, err)
	}
	s, _ = DecodeModelsDev(data, later.Add(24*time.Hour))
	if !s.publishedAt.Equal(later) {
		t.Fatal("outage rejuvenated age")
	}
	after, _ := os.ReadFile(path)
	if string(raw) != string(after) {
		t.Fatal("outage changed disk cache")
	}
	var store Store
	_ = store.Publish(data, later.Add(24*time.Hour))
	if store.Snapshot(later.Add(24*time.Hour), time.Hour) != nil {
		t.Fatal("expired evidence retained ranking authority")
	}
}
func TestDraftLiveCacheRefusesPoisonAndSourceMismatch(t *testing.T) {
	for _, status := range []int{200, 302, 429, 304} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			calls := 0
			c := NewLiveCache(&http.Client{Transport: fixtureRoundTripper(func(r *http.Request) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: status, Header: http.Header{"Location": {"https://other.example"}}, Body: io.NopCloser(strings.NewReader(`{"models":{"bad":{}}}`))}, nil
			})})
			if _, _, err := c.Refresh(context.Background(), LiveCatalogURL, "", fixtureNow); err == nil {
				t.Fatal("invalid cold response accepted")
			}
			if calls != 1 {
				t.Fatal("redirect/retry")
			}
		})
	}
	path := filepath.Join(t.TempDir(), "cache.json")
	e := cachedEvidence{Source: "https://other.example/catalog.json", ValidatedAt: fixtureNow, Data: json.RawMessage(fixtureLiveBody())}
	raw, _ := json.Marshal(e)
	_ = os.WriteFile(path, raw, 0600)
	c := NewLiveCache(nil)
	if _, ok := c.Cached(LiveCatalogURL, path, fixtureNow); ok {
		t.Fatal("foreign source cache admitted")
	}
	if _, _, err := c.Refresh(context.Background(), "http://models.dev/catalog.json", path, fixtureNow); err == nil {
		t.Fatal("unsupported source admitted")
	}
}
func TestDraftLiveCacheInvalidRefreshPreservesValidBody(t *testing.T) {
	calls := 0
	c := NewLiveCache(&http.Client{Transport: fixtureRoundTripper(func(*http.Request) (*http.Response, error) {
		calls++
		body := fixtureLiveBody()
		if calls > 1 {
			body = `{"models":{"lab/a":{},"lab/a":{}}}`
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})})
	first, _, err := c.Refresh(context.Background(), LiveCatalogURL, "", fixtureNow)
	if err != nil {
		t.Fatal(err)
	}
	second, fresh, err := c.Refresh(context.Background(), LiveCatalogURL, "", fixtureNow.Add(time.Hour))
	if err != nil || fresh || string(first) != string(second) {
		t.Fatal("poisoned last good", fresh, err)
	}
}
