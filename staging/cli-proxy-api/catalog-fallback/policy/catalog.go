// Package catalogfallback proposes alternate models; it never dispatches an
// inference, owns credentials, or grants free entitlement.
package catalogfallback

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

const MaxCatalogBytes = 32 << 20

type Benchmark struct {
	Name    string          `json:"name"`
	Score   json.RawMessage `json:"score"`
	Metric  string          `json:"metric"`
	Harness string          `json:"harness"`
	Variant string          `json:"variant"`
	Dataset string          `json:"dataset"`
	Version string          `json:"version"`
	Source  string          `json:"source"`
	Date    string          `json:"date"`
}
type Model struct {
	ID         string      `json:"id"`
	Family     string      `json:"family"`
	Type       string      `json:"type"`
	Benchmarks []Benchmark `json:"benchmarks"`
}
type Snapshot struct {
	models      map[string]Model
	links       map[string]string
	publishedAt time.Time
	source      string
}

// DecodeModelsDev consumes the documented combined /catalog.json shape. It
// does NOT consume the repository-root models.json (an unrelated provider dump),
// nor infer identities from model names. Extra additive fields are tolerated.
func DecodeModelsDev(data []byte, now time.Time) (*Snapshot, error) {
	if len(data) == 0 || len(data) > MaxCatalogBytes {
		return nil, errors.New("catalog size invalid")
	}
	if err := validateJSONKeys(data); err != nil {
		return nil, err
	}
	var raw struct {
		Evidence struct {
			RetrievedAt string `json:"retrieved_at"`
		} `json:"_evidence"`
		Models    map[string]Model `json:"models"`
		Providers map[string]struct {
			Models map[string]struct {
				ID          string `json:"id"`
				CanonicalID string `json:"canonical_model_id"`
			} `json:"models"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, errors.New("invalid models.dev catalog JSON")
	}
	if len(raw.Models) == 0 || len(raw.Models) > 30000 {
		return nil, errors.New("models.dev canonical models missing or excessive")
	}
	if raw.Evidence.RetrievedAt != "" {
		t, err := time.Parse(time.RFC3339Nano, raw.Evidence.RetrievedAt)
		if err != nil || t.After(now.Add(5*time.Minute)) {
			return nil, errors.New("invalid evidence retrieval timestamp")
		}
		now = t
	}
	s := &Snapshot{models: map[string]Model{}, links: map[string]string{}, publishedAt: now}
	for id, m := range raw.Models {
		if !qualifiedID(id) || (m.ID != "" && m.ID != id) || len(m.Benchmarks) > 1000 {
			return nil, errors.New("invalid canonical identity or benchmark count")
		}
		m.ID = id
		// Scores retain their original provenance and evaluation settings. No raw
		// number becomes a quality estimate until comparability has been checked.
		for _, b := range m.Benchmarks {
			if len(b.Score) > 256 || len(b.Name) > 256 {
				return nil, errors.New("invalid benchmark record")
			}
		}
		s.models[id] = m
	}
	count := 0
	for provider, p := range raw.Providers {
		if provider == "" || strings.ContainsAny(provider, "\x00\r\n") {
			return nil, errors.New("invalid provider identity")
		}
		for source, m := range p.Models {
			count++
			if count > 200000 {
				return nil, errors.New("too many provider links")
			}
			if m.CanonicalID == "" {
				continue
			} // Host-unique models remain unknown.
			if source == "" || strings.ContainsAny(source, "\x00\r\n") || (m.ID != "" && m.ID != source) {
				return nil, errors.New("invalid provider model identity")
			}
			if _, ok := s.models[m.CanonicalID]; !ok {
				return nil, errors.New("dangling provider-to-canonical identity")
			}
			s.links[provider+"\x00"+source] = m.CanonicalID
		}
	}
	return s, nil
}
func qualifiedID(id string) bool {
	p := strings.SplitN(id, "/", 2)
	return len(p) == 2 && p[0] != "" && p[1] != "" && len(id) < 1024 && !strings.ContainsAny(id, "\x00\r\n")
}
func (s *Snapshot) Resolve(provider, source string) (string, bool) {
	if s == nil {
		return "", false
	}
	id, ok := s.links[provider+"\x00"+source]
	return id, ok
}
func (s *Snapshot) model(id string) (Model, bool) {
	if s == nil {
		return Model{}, false
	}
	m, ok := s.models[id]
	return m, ok
}
func (s *Snapshot) Count() int {
	if s == nil {
		return 0
	}
	return len(s.models)
}
func (s *Snapshot) Family(id string) string {
	m, ok := s.model(id)
	if !ok || m.Family == "" {
		return ""
	}
	// A family label is scoped to its canonical publisher, never stripped from an
	// unknown namespace. No family match establishes opaque-state portability.
	return strings.SplitN(id, "/", 2)[0] + "/" + m.Family
}

type Store struct{ current atomic.Pointer[Snapshot] }

func (s *Store) Publish(data []byte, now time.Time) error {
	return s.PublishFrom("", data, now)
}
func (s *Store) PublishFrom(source string, data []byte, now time.Time) error {
	candidate, err := DecodeModelsDev(data, now)
	if err != nil {
		return err
	}
	candidate.source = source
	s.current.Store(candidate)
	return nil
}
func (s *Store) Snapshot(now time.Time, maxAge time.Duration) *Snapshot {
	v := s.current.Load()
	if v == nil || maxAge <= 0 || now.Before(v.publishedAt) || now.Sub(v.publishedAt) > maxAge {
		return nil
	}
	return v
}

var DefaultStore Store

// Canonical benchmark identity is shared by classification, conflict handling,
// coverage and support counts. Aliases are provenance labels, not new evidence.
func benchmarkIdentity(name string) string {
	n := strings.ToLower(strings.NewReplacer("-", "", "_", "", " ", "", "'", "").Replace(name))
	switch n {
	case "berkeleyfunctioncallingleaderboard":
		return "bfcl"
	case "humanityslastexam":
		return "hle"
	}
	return n
}
func benchmarkCategory(name string) Task {
	n := benchmarkIdentity(name)
	switch n {
	case "terminalbench", "swebenchverified", "swebenchpro", "deepswe", "livecodebench", "scicode":
		return Coding
	case "bfcl", "berkeleyfunctioncallingleaderboard", "taubench", "tau2bench", "toolathlon":
		return Agent
	case "ruler", "aalcr", "longbench", "longbenchv2":
		return LongContext
	case "aime", "aime2025", "aime2026", "math500", "gpqadiamond", "hle", "humanityslastexam":
		return Reasoning
	case "ifeval", "ifbench":
		return Structured
	case "mmlupro", "mmlu":
		return General
	}
	return ""
}

// Comparable benchmark records use an explicit version, harness and variant.
// Unknown contexts and arbitrary metrics (e.g. Elo) stay unknown. Only documented
// accuracy/pass-rate percentage metrics are normalized here, not arbitrary data.
func normalizedBenchmark(b Benchmark, task Task) (string, float64, bool) {
	if b.Version == "" || b.Harness == "" || b.Variant == "" {
		return "", 0, false
	}
	return benchmarkValue(b, task)
}
func benchmarkValue(b Benchmark, task Task) (string, float64, bool) {
	category := benchmarkCategory(b.Name)
	if category == "" || (task != General && category != task && !(task == Agent && category == Coding)) {
		return "", 0, false
	}
	u, err := url.Parse(b.Source)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return "", 0, false
	}
	metric := strings.ToLower(b.Metric)
	switch metric {
	case "accuracy", "pass@1", "resolved":
	default:
		return "", 0, false
	}
	// models.dev score strings can be ranges/descriptions. Do not invent a point.
	// A positive value <=1 has ambiguous fraction/percentage units in this schema.
	// Keep it unknown rather than comparing it to unambiguous percentage values.
	var value float64
	if len(b.Score) == 0 || bytes.Equal(bytes.TrimSpace(b.Score), []byte("null")) || bytes.HasPrefix(bytes.TrimSpace(b.Score), []byte(`"`)) || json.Unmarshal(b.Score, &value) != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 100 || (value > 0 && value <= 1) {
		return "", 0, false
	}
	fields := []string{strings.ToLower(b.Name), b.Version, b.Harness, b.Variant, b.Dataset, metric}
	encoded, _ := json.Marshal(fields)
	return string(encoded), value / 100, true
}
func (s *Snapshot) String() string { return fmt.Sprintf("catalog models=%d", s.Count()) }

func (s *Store) SnapshotForSource(source string, now time.Time, maxAge time.Duration) *Snapshot {
	if source == "" || source == "disabled" {
		return nil
	}
	v := s.Snapshot(now, maxAge)
	if v == nil || v.source != source {
		return nil
	}
	return v
}

// Reject duplicate object keys and excessive nesting rather than silently
// accepting last-wins canonical identity or link overrides.
func validateJSONKeys(data []byte) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var value func(int) error
	value = func(depth int) error {
		if depth > 64 {
			return errors.New("catalog nesting excessive")
		}
		token, err := d.Token()
		if err != nil {
			return errors.New("invalid catalog JSON")
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delimiter {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return errors.New("duplicate catalog key")
				}
				seen[name] = true
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		case '[':
			for d.More() {
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		default:
			return errors.New("unexpected catalog JSON delimiter")
		}
		_, err = d.Token()
		return err
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("trailing catalog JSON")
	}
	return nil
}

// ValidateProtocolJSON rejects duplicate keys and excessive nesting without
// interpreting schema/argument contents as protocol controls.
func ValidateProtocolJSON(raw []byte) error { return validateJSONKeys(raw) }

// AdvisorySnapshot keeps historical task qualification available through feed
// outages. Stale data cannot regain benchmark ranking authority or admit a
// route/cost: those checks use fresh evidence/native state separately.
func (s *Store) AdvisorySnapshot(source string, now time.Time, maxAge time.Duration) (*Snapshot, bool) {
	v := s.current.Load()
	if v == nil || v.source != source || now.Before(v.publishedAt) {
		return nil, false
	}
	return v, maxAge > 0 && now.Sub(v.publishedAt) <= maxAge
}

// Reference-only lookup: an exact canonical ID or unambiguous exact source ID
// can anchor a preference even after the provider's route was removed. This
// never creates a route, aliases names fuzzily, or grants billing permission.
func (s *Snapshot) ResolveReference(id string) (string, bool) {
	if s == nil {
		return "", false
	}
	if _, ok := s.models[id]; ok {
		return id, true
	}
	found := ""
	for key, canonical := range s.links {
		parts := strings.SplitN(key, "\x00", 2)
		if len(parts) != 2 || parts[1] != id {
			continue
		}
		if found != "" && found != canonical {
			return "", false
		}
		found = canonical
	}
	return found, found != ""
}
