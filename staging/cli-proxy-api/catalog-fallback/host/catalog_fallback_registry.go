package registry

import (
	"context"
	"encoding/json"
	"errors"
	log "github.com/sirupsen/logrus"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback"
)

// Reuse the host catalog-updater lifecycle/generation fencing. This source is
// advisory evidence only: it does not publish routes, auths, costs or aliases.
var fallbackEvidenceUpdater = newFallbackEvidenceUpdater()

func newFallbackEvidenceUpdater() *catalogUpdater {
	u := &catalogUpdater{fetch: readFallbackEvidence}
	u.publish = func(data []byte) ([]string, error) {
		err := catalogfallback.DefaultStore.PublishFrom(u.source, data, time.Now())
		if err == nil {
			log.Info("fallback evidence metadata loaded")
		}
		return nil, err
	}
	return u
}
func readFallbackEvidence(ctx context.Context, source string) ([]byte, error) {
	var reader io.ReadCloser
	if filepath.IsAbs(source) {
		f, err := os.Open(source)
		if err != nil {
			return nil, errors.New("fallback evidence file unavailable")
		}
		reader = f
	} else {
		u, err := url.Parse(source)
		if err != nil || u.Scheme != "https" || u.User != nil || u.Host != "models.dev" || u.Path != "/catalog.json" || u.RawQuery != "" || u.Fragment != "" {
			return nil, errors.New("fallback evidence URL must be https://models.dev/catalog.json")
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
		if err != nil {
			return nil, err
		}
		client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		res, err := client.Do(req)
		if err != nil {
			return nil, errors.New("fallback evidence fetch failed")
		}
		if res.StatusCode != 200 {
			res.Body.Close()
			return nil, errors.New("fallback evidence HTTP status refused")
		}
		reader = res.Body
	}
	defer reader.Close()
	b, err := io.ReadAll(io.LimitReader(reader, catalogfallback.MaxCatalogBytes+1))
	if err != nil || len(b) > catalogfallback.MaxCatalogBytes {
		return nil, errors.New("fallback evidence size/read failure")
	}
	if filepath.IsAbs(source) {
		var envelope struct {
			Evidence struct {
				RetrievedAt string `json:"retrieved_at"`
			} `json:"_evidence"`
		}
		if json.Unmarshal(b, &envelope) != nil || envelope.Evidence.RetrievedAt == "" {
			return nil, errors.New("local evidence needs retrieval timestamp; use the snapshot importer")
		}
	}
	return b, nil
}

// Expiry-aware registry check, paired with the native auth-manager predicate.
// No state is removed, resumed, refreshed, or probed by this read.
func (r *ModelRegistry) CanonicalFallbackRegistryAvailable(client, route string, now time.Time) bool {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	info := r.clientModelInfos[client][route]
	if info == nil {
		return false
	}
	for _, key := range []string{route, info.CanonicalID, info.CanonicalSourceID, info.MetadataModelID} {
		registration := r.models[key]
		if registration == nil {
			continue
		}
		if q := registration.QuotaExceededClients[client]; q != nil && now.Before(q.Add(modelQuotaExceededWindow)) {
			return false
		}
		if reason, ok := registration.SuspendedClients[client]; ok && !isQuotaSuspension(reason) {
			return false
		}
	}
	return true
}

func ValidateFallbackEvidenceSource(source string) error {
	if source == "" || source == "disabled" || filepath.IsAbs(source) {
		return nil
	}
	u, err := url.Parse(source)
	if err != nil || u.Scheme != "https" || u.Host != "models.dev" || u.Path != "/catalog.json" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("unsupported fallback evidence source")
	}
	return nil
}
