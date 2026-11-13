package catalogfallback

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const LiveCatalogURL = "https://models.dev/catalog.json"

type cachedEvidence struct {
	Source       string          `json:"source"`
	ETag         string          `json:"etag,omitempty"`
	LastModified string          `json:"last_modified,omitempty"`
	ValidatedAt  time.Time       `json:"validated_at"`
	Data         json.RawMessage `json:"data"`
}

// LiveCache is used by the host's background updater, never by an inference.
// Failed HTTP/validation retains the previous data AND its validation timestamp.
// Fresh means an origin 200 or conditional 304, not a local cache read.
type LiveCache struct {
	mu      sync.Mutex
	entries map[string]cachedEvidence
	client  *http.Client
}

func NewLiveCache(client *http.Client) *LiveCache {
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &LiveCache{client: &copyClient, entries: map[string]cachedEvidence{}}
}
func cacheKey(source, path string) string { return source + "\x00" + path }
func stampEvidence(raw []byte, at time.Time) ([]byte, error) {
	if _, err := DecodeModelsDev(raw, at); err != nil {
		return nil, err
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, err
	}
	var evidence map[string]any
	if b := root["_evidence"]; len(b) > 0 {
		if err := json.Unmarshal(b, &evidence); err != nil {
			return nil, err
		}
	}
	if evidence == nil {
		evidence = map[string]any{}
	}
	evidence["retrieved_at"] = at.UTC().Format(time.RFC3339Nano)
	root["_evidence"], _ = json.Marshal(evidence)
	return json.Marshal(root)
}
func (c *LiveCache) load(source, path string, now time.Time) (cachedEvidence, bool) {
	key := cacheKey(source, path)
	if e, ok := c.entries[key]; ok {
		return e, true
	}
	if path == "" {
		return cachedEvidence{}, false
	}
	f, err := os.Open(path)
	if err != nil {
		return cachedEvidence{}, false
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, MaxCatalogBytes+(1<<20)+1))
	if err != nil || len(raw) > MaxCatalogBytes+(1<<20) {
		return cachedEvidence{}, false
	}
	if validateJSONKeys(raw) != nil {
		return cachedEvidence{}, false
	}
	var e cachedEvidence
	if json.Unmarshal(raw, &e) != nil || e.Source != source || e.ValidatedAt.IsZero() || e.ValidatedAt.After(now) || len(e.ETag) > 4096 || len(e.LastModified) > 4096 {
		return cachedEvidence{}, false
	}
	s, err := DecodeModelsDev(e.Data, now)
	if err != nil || !s.publishedAt.Equal(e.ValidatedAt) {
		return cachedEvidence{}, false
	}
	c.entries[key] = e
	return e, true
}
func (c *LiveCache) Cached(source, path string, now time.Time) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.load(source, path, now)
	if !ok {
		return nil, false
	}
	return append([]byte(nil), e.Data...), true
}
func persistEvidence(path string, e cachedEvidence) error {
	if path == "" {
		return nil
	}
	if !filepath.IsAbs(path) {
		return errors.New("evidence cache path must be absolute")
	}
	raw, err := json.Marshal(e)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".fallback-evidence-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, path)
}
func (c *LiveCache) Refresh(ctx context.Context, source, path string, now time.Time) (data []byte, fresh bool, err error) {
	if (source != LiveCatalogURL && source != GitCatalogURL) || (path != "" && !filepath.IsAbs(path)) {
		return nil, false, errors.New("unsupported live evidence source/cache")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	old, have := c.load(source, path, now)
	fallback := func() ([]byte, bool, error) {
		if have {
			return append([]byte(nil), old.Data...), false, nil
		}
		return nil, false, errors.New("live evidence unavailable; no valid cache")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return fallback()
	}
	if have {
		req.Header.Set("If-None-Match", old.ETag)
		req.Header.Set("If-Modified-Since", old.LastModified)
	}
	res, err := c.client.Do(req)
	if err != nil {
		return fallback()
	}
	defer res.Body.Close()
	next := cachedEvidence{Source: source, ValidatedAt: now, ETag: res.Header.Get("ETag"), LastModified: res.Header.Get("Last-Modified")}
	if len(next.ETag) > 4096 || len(next.LastModified) > 4096 {
		return fallback()
	}
	switch res.StatusCode {
	case http.StatusNotModified:
		if !have || (old.ETag == "" && old.LastModified == "") {
			return fallback()
		}
		// A conflicting 304 validator is not a validation of our stored body.
		if next.ETag != "" && old.ETag != "" && next.ETag != old.ETag {
			return fallback()
		}
		if next.ETag == "" {
			next.ETag = old.ETag
		}
		if next.LastModified == "" {
			next.LastModified = old.LastModified
		}
		next.Data, err = stampEvidence(old.Data, now)
	case http.StatusOK:
		var raw []byte
		raw, err = io.ReadAll(io.LimitReader(res.Body, MaxCatalogBytes+1))
		if err != nil || len(raw) > MaxCatalogBytes {
			return fallback()
		}
		if source == GitCatalogURL {
			raw, err = c.githubCatalog(ctx, raw, now)
			if err != nil {
				return fallback()
			}
		}
		next.Data, err = stampEvidence(raw, now)
	default:
		return fallback()
	}
	if err != nil {
		return fallback()
	}
	// Keep valid fresh memory even when disk is unwritable. Report persistence
	// failure separately; it must not erase last-good memory or pretend durable.
	c.entries[cacheKey(source, path)] = next
	if err = persistEvidence(path, next); err != nil {
		return append([]byte(nil), next.Data...), true, errors.New("live evidence refreshed but cache persistence failed")
	}
	return append([]byte(nil), next.Data...), true, nil
}
