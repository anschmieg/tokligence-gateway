package hostbridge

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type redirectFixtureTransport func(*http.Request) (*http.Response, error)

func (f redirectFixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestBridgeClientsNeverRedispatchRedirect(t *testing.T) {
	for _, factory := range []func(context.Context, time.Duration) *http.Client{Client, StreamClient} {
		client := factory(context.Background(), time.Second)
		count := 0
		client.Transport = redirectFixtureTransport(func(r *http.Request) (*http.Response, error) {
			count++
			return &http.Response{StatusCode: 307, Header: http.Header{"Location": {"https://redirect.invalid/target"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		})
		response, err := client.Post("https://origin.invalid/test", "application/json", strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 307 || count != 1 {
			t.Fatalf("redirect caused %d physical callbacks", count)
		}
	}
}
