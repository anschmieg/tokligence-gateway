package catalogfallback

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

const GitCatalogURL = "https://api.github.com/repos/anomalyco/models.dev/commits/dev"
const maxMetadataArchive = 32 << 20
const maxMetadataExpanded = 128 << 20

var metadataCommit = regexp.MustCompile(`^[0-9a-f]{40}$`)

// ConvertModelsDevArchive reads data only, never extracts files or runs code.
// Aliases are resolved inside the bounded archive and cannot escape its data tree.
func ConvertModelsDevArchive(raw []byte, commit string, now time.Time) ([]byte, error) {
	if len(raw) > maxMetadataArchive || !metadataCommit.MatchString(commit) {
		return nil, errors.New("invalid metadata archive/commit")
	}
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	payload, err := io.ReadAll(io.LimitReader(gz, maxMetadataExpanded+1))
	if err != nil || len(payload) > maxMetadataExpanded {
		return nil, errors.New("invalid/oversized decompressed metadata archive")
	}
	tr := tar.NewReader(bytes.NewReader(payload))
	records := map[string][]byte{}
	aliases := map[string]string{}
	seen := map[string]bool{}
	root := ""
	count := 0
	expanded := int64(0)
	relevant := func(name string) bool {
		p := strings.Split(name, "/")
		return strings.HasSuffix(name, ".toml") && ((len(p) >= 3 && p[0] == "models") || (len(p) >= 4 && p[0] == "providers" && p[2] == "models"))
	}
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, e
		}
		count++
		expanded += h.Size
		if count > 60000 || h.Size < 0 || expanded > maxMetadataExpanded {
			return nil, errors.New("metadata archive limits")
		}
		if h.Typeflag == tar.TypeXGlobalHeader {
			continue
		} // archive metadata, not an extracted data entry
		if strings.HasPrefix(h.Name, "/") {
			return nil, errors.New("unsafe archive path")
		}
		parts := strings.Split(h.Name, "/")
		for _, p := range parts {
			if p == ".." {
				return nil, errors.New("unsafe archive path")
			}
		}
		if root == "" {
			root = parts[0]
		}
		if parts[0] != root {
			return nil, errors.New("multiple archive roots")
		}
		name := strings.Join(parts[1:], "/")
		if !relevant(name) {
			continue
		}
		if seen[name] {
			return nil, errors.New("duplicate archive data path")
		}
		seen[name] = true
		switch h.Typeflag {
		case tar.TypeReg:
			if h.Size > 1<<20 {
				return nil, errors.New("metadata record too large")
			}
			b, e := io.ReadAll(io.LimitReader(tr, (1<<20)+1))
			if e != nil {
				return nil, e
			}
			records[name] = b
		case tar.TypeSymlink:
			target := path.Clean(path.Join(path.Dir(name), h.Linkname))
			if strings.HasPrefix(h.Linkname, "/") || strings.HasPrefix(target, "../") || !relevant(target) {
				return nil, errors.New("unsafe metadata alias")
			}
			aliases[name] = target
		default:
			return nil, errors.New("nonregular metadata record")
		}
	}
	var resolve func(string, map[string]bool) ([]byte, error)
	resolve = func(name string, trail map[string]bool) ([]byte, error) {
		if len(trail) > 16 || trail[name] {
			return nil, errors.New("cyclic/deep metadata alias")
		}
		if b, ok := records[name]; ok {
			return b, nil
		}
		if target, ok := aliases[name]; ok {
			trail[name] = true
			return resolve(target, trail)
		}
		return nil, errors.New("dangling metadata alias")
	}
	models := map[string]any{}
	providers := map[string]map[string]any{}
	for name := range seen {
		b, e := resolve(name, map[string]bool{})
		if e != nil {
			return nil, e
		}
		var r map[string]any
		if e = toml.Unmarshal(b, &r); e != nil {
			return nil, e
		}
		if schema, ok := r["schema"].(int64); !ok || schema != 2 {
			return nil, errors.New("unsupported authored metadata schema")
		}
		parts := strings.Split(name, "/")
		if parts[0] == "models" {
			id := strings.TrimSuffix(strings.Join(parts[1:], "/"), ".toml")
			model := map[string]any{"id": id}
			for _, field := range []string{"name", "description", "family", "type", "benchmarks", "weights", "links", "license", "release_date", "last_updated"} {
				if v, ok := r[field]; ok {
					model[field] = v
				}
			}
			models[id] = model
		} else if base, ok := r["base_model"]; ok {
			id, valid := base.(string)
			if !valid {
				return nil, errors.New("invalid canonical link")
			}
			provider := parts[1]
			source := strings.TrimSuffix(strings.Join(parts[3:], "/"), ".toml")
			if providers[provider] == nil {
				providers[provider] = map[string]any{}
			}
			providers[provider][source] = map[string]any{"id": source, "canonical_model_id": id}
		}
	}
	links := map[string]any{}
	for p, models := range providers {
		links[p] = map[string]any{"models": models}
	}
	hash := sha256.Sum256(raw)
	data, err := json.Marshal(map[string]any{"models": models, "providers": links, "_evidence": map[string]any{"source": GitCatalogURL, "source_commit": commit, "archive_sha256": hex.EncodeToString(hash[:]), "license": "MIT", "retrieved_at": now.UTC().Format(time.RFC3339Nano)}})
	if err != nil {
		return nil, err
	}
	if _, err = DecodeModelsDev(data, now); err != nil {
		return nil, err
	}
	return data, nil
}
func (c *LiveCache) githubCatalog(ctx context.Context, commitJSON []byte, now time.Time) ([]byte, error) {
	var head struct {
		SHA string `json:"sha"`
	}
	if json.Unmarshal(commitJSON, &head) != nil || !metadataCommit.MatchString(head.SHA) {
		return nil, errors.New("invalid metadata commit response")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://codeload.github.com/anomalyco/models.dev/tar.gz/"+head.SHA, nil)
	if err != nil {
		return nil, err
	}
	res, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("metadata archive unavailable")
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxMetadataArchive+1))
	if err != nil {
		return nil, err
	}
	return ConvertModelsDevArchive(raw, head.SHA, now)
}
