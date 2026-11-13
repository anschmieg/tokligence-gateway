// catalog-fallback-preview is a dry-run inspector, not an inference client.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback"
	"io"
	"os"
	"time"
)

func read(path string, limit int64) ([]byte, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, limit+1))
	if e == nil && int64(len(b)) > limit {
		return nil, fmt.Errorf("input too large")
	}
	return b, e
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "catalog preview failed:", err)
		os.Exit(1)
	}
}
func run() error {
	refreshSource := flag.String("refresh-source", "", "refresh public metadata only; no inference")
	cachePath := flag.String("cache", "", "absolute persistent metadata cache path")
	catalog := flag.String("catalog", "", "combined metadata snapshot")
	requested := flag.String("model", "", "requested canonical model")
	request := flag.String("request", "", "offline request JSON (never sent)")
	routeFile := flag.String("routes", "", "offline native-admitted route JSON")
	check := flag.Bool("check", false, "validate metadata only")
	flag.Parse()
	var data []byte
	var err error
	fresh := false
	if *refreshSource != "" {
		data, fresh, err = catalogfallback.NewLiveCache(nil).Refresh(context.Background(), *refreshSource, *cachePath, time.Now())
	} else if *catalog != "" {
		data, err = read(*catalog, catalogfallback.MaxCatalogBytes)
	} else {
		return fmt.Errorf("--catalog or --refresh-source is required")
	}
	if err != nil {
		return err
	}
	var store catalogfallback.Store
	now := time.Now()
	if err = store.Publish(data, now); err != nil {
		return err
	}
	snapshot := store.Snapshot(now, 7*24*time.Hour)
	if *check {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"catalog_available": snapshot != nil, "models": snapshot.Count(), "origin_validated_this_run": fresh, "provider_inference_requests": 0})
	}
	if *requested == "" || *request == "" || *routeFile == "" {
		return fmt.Errorf("--model, --request and --routes required for ranking")
	}
	raw, err := read(*request, 4<<20)
	if err != nil {
		return err
	}
	req, err := catalogfallback.RequirementsFromJSON(raw)
	if err != nil {
		return err
	}
	raw, err = read(*routeFile, 4<<20)
	if err != nil {
		return err
	}
	var routes []catalogfallback.Route
	if err = json.Unmarshal(raw, &routes); err != nil {
		return err
	}
	plan := catalogfallback.Rank(*requested, req, routes, snapshot, catalogfallback.Policy{AllowUnknown: true})
	// Auth handles are controller-private and omitted from the diagnostic output.
	for i := range plan.Candidates {
		plan.Candidates[i].RouteIDs = nil
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"catalog_available": snapshot != nil, "plan": plan, "provider_inference_requests": 0})
}
