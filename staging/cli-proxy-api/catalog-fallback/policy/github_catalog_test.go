package catalogfallback

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func fixtureMetadataArchive(t *testing.T, evil bool) []byte {
	t.Helper()
	var out bytes.Buffer
	gz := gzip.NewWriter(&out)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "pax_global_header", Typeflag: tar.TypeXGlobalHeader, Format: tar.FormatPAX, PAXRecords: map[string]string{"comment": "metadata-only header"}}); err != nil {
		t.Fatal(err)
	}
	add := func(name, body string) {
		if err := tw.WriteHeader(&tar.Header{Name: "repo/" + name, Mode: 0600, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write([]byte(body))
	}
	add("models/lab/a.toml", "schema = 2\nfamily = 'fixture'\ntype = 'chat'\n")
	add("providers/fixture/models/source.toml", "schema = 2\nbase_model = 'lab/a'\n")
	target := "source.toml"
	if evil {
		target = "../../../../outside.toml"
	}
	_ = tw.WriteHeader(&tar.Header{Name: "repo/providers/fixture/models/alias.toml", Typeflag: tar.TypeSymlink, Linkname: target})
	_ = tw.Close()
	_ = gz.Close()
	return out.Bytes()
}
func TestDraftNativeLiveGitDataConversionAndConditionalCache(t *testing.T) {
	raw := fixtureMetadataArchive(t, false)
	commit := strings.Repeat("a", 40)
	calls := 0
	c := NewLiveCache(&http.Client{Transport: fixtureRoundTripper(func(r *http.Request) (*http.Response, error) {
		calls++
		status := 200
		body := raw
		headers := http.Header{}
		switch r.URL.String() {
		case GitCatalogURL:
			if calls == 1 {
				body = []byte(`{"sha":"` + commit + `"}`)
				headers.Set("ETag", `"head-v1"`)
			} else {
				if r.Header.Get("If-None-Match") != `"head-v1"` {
					t.Fatal("lost commit validator")
				}
				status = 304
				body = nil
			}
		case "https://codeload.github.com/anomalyco/models.dev/tar.gz/" + commit:
		default:
			t.Fatal("unapproved metadata request", r.URL)
		}
		return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(bytes.NewReader(body))}, nil
	})})
	data, fresh, err := c.Refresh(context.Background(), GitCatalogURL, "", fixtureNow)
	if err != nil || !fresh {
		t.Fatal(fresh, err)
	}
	s, err := DecodeModelsDev(data, fixtureNow)
	if err != nil {
		t.Fatal(err)
	}
	if id, ok := s.Resolve("fixture", "alias"); !ok || id != "lab/a" {
		t.Fatal(id, ok)
	}
	_, fresh, err = c.Refresh(context.Background(), GitCatalogURL, "", fixtureNow)
	if err != nil || !fresh || calls != 3 {
		t.Fatal("304 redownloaded archive", calls, fresh, err)
	}
}
func TestDraftNativeGitArchiveAliasesAndProvenance(t *testing.T) {
	commit := strings.Repeat("b", 40)
	data, err := ConvertModelsDevArchive(fixtureMetadataArchive(t, false), commit, fixtureNow)
	if err != nil {
		t.Fatal(err)
	}
	var root map[string]any
	_ = json.Unmarshal(data, &root)
	evidence := root["_evidence"].(map[string]any)
	if evidence["source_commit"] != commit || evidence["archive_sha256"] == "" {
		t.Fatal(evidence)
	}
	if _, err = ConvertModelsDevArchive(fixtureMetadataArchive(t, true), commit, fixtureNow); err == nil {
		t.Fatal("escaping symlink accepted")
	}
	if _, err = ConvertModelsDevArchive([]byte("garbage"), commit, fixtureNow); err == nil {
		t.Fatal("corrupt archive accepted")
	}
	if _, err = ConvertModelsDevArchive(fixtureMetadataArchive(t, false), "not-a-sha", fixtureNow); err == nil {
		t.Fatal("unversioned archive accepted")
	}
}
