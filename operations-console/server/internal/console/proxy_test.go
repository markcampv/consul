package console

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type seen struct {
	method, path, rawQuery string
	header                 http.Header
}

func newTestProxy(t *testing.T, upstream http.HandlerFunc) (*Proxy, *[]seen) {
	t.Helper()
	var calls []seen
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, seen{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Clone()})
		upstream(w, r)
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	return &Proxy{
		Upstream:  u,
		Client:    srv.Client(),
		Routes:    ReadOnlyRoutes,
		Timeout:   2 * time.Second,
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		UserAgent: "test",
	}, &calls
}

func okUpstream(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Consul-Default-Acl-Policy", "deny")
	w.Header().Set("X-Consul-Results-Filtered-By-Acls", "true")
	w.Header().Set("Set-Cookie", "upstream=1")
	w.Header().Set("X-Internal-Secret", "nope")
	_, _ = w.Write([]byte(`["dc1"]`))
}

func do(p http.Handler, method, target string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	return rec
}

func TestProxyAllowsReadOnlyAllowlistedPaths(t *testing.T) {
	p, calls := newTestProxy(t, okUpstream)
	for _, target := range []string{
		"/v1/catalog/datacenters",
		"/v1/internal/ui/services?dc=dc1",
		"/v1/internal/ui/service-topology/api?dc=dc1&kind=",
		"/v1/health/service/payments?dc=dc1",
		"/v1/status/leader",
		"/v1/namespaces",
	} {
		rec := do(p, http.MethodGet, target, nil)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200 (%s)", target, rec.Code, rec.Body)
		}
	}
	if len(*calls) != 6 {
		t.Fatalf("upstream calls = %d, want 6", len(*calls))
	}
	if got := (*calls)[2].rawQuery; got != "dc=dc1&kind=" {
		t.Errorf("query not preserved: %q", got)
	}
}

func TestProxyRejectsWrites(t *testing.T) {
	p, calls := newTestProxy(t, okUpstream)
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		rec := do(p, m, "/v1/internal/ui/services", nil)
		if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("X-Console-Blocked") != "method" {
			t.Errorf("%s = %d %q, want 405 blocked", m, rec.Code, rec.Header().Get("X-Console-Blocked"))
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("writes reached upstream: %v", *calls)
	}
}

func TestProxyRejectsSensitiveAndUnknownEndpoints(t *testing.T) {
	p, calls := newTestProxy(t, okUpstream)
	for _, target := range []string{
		"/v1/kv/secret",
		"/v1/acl/tokens",
		"/v1/agent/self",
		"/v1/config/inline-certificate/x",
		"/v1/internal/ui/metrics-proxy/api/v1/query",
		"/v1/snapshot",
		"/v1/health/service/",      // prefix route needs a name
		"/v1/catalog/datacentersX", // no prefix match on exact routes
		"/v1/internal/ui/servicesfoo",
	} {
		rec := do(p, http.MethodGet, target, nil)
		if rec.Code != http.StatusForbidden && rec.Code != http.StatusBadRequest {
			t.Errorf("GET %s = %d, want 403/400", target, rec.Code)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("blocked paths reached upstream: %v", *calls)
	}
}

func TestProxyRejectsTraversal(t *testing.T) {
	p, calls := newTestProxy(t, okUpstream)
	for _, target := range []string{
		"/v1/health/service/../../kv/secret",
		"/v1/health/service/a%2F..%2F..%2Fkv",
		"/v1/health/service//x",
		"/v1/health/service/x/",
	} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		u, err := url.Parse(target)
		if err != nil {
			t.Fatal(err)
		}
		req.URL = u
		rec := httptest.NewRecorder()
		p.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("GET %s = %d, want 400", target, rec.Code)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("traversal reached upstream: %v", *calls)
	}
}

func TestProxyForwardsOnlyTokenHeaderAndStripsQueryToken(t *testing.T) {
	p, calls := newTestProxy(t, okUpstream)
	rec := do(p, http.MethodGet, "/v1/catalog/datacenters?token=leaky&dc=dc1", map[string]string{
		"X-Consul-Token":  "secret",
		"Cookie":          "session=abc",
		"Authorization":   "Bearer other",
		"X-Forwarded-For": "1.2.3.4",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	c := (*calls)[0]
	if c.header.Get("X-Consul-Token") != "secret" {
		t.Errorf("token not forwarded")
	}
	for _, h := range []string{"Cookie", "Authorization", "X-Forwarded-For"} {
		if c.header.Get(h) != "" {
			t.Errorf("%s forwarded to Consul", h)
		}
	}
	if strings.Contains(c.rawQuery, "token") || c.rawQuery != "dc=dc1" {
		t.Errorf("query = %q, want token stripped", c.rawQuery)
	}
}

func TestProxyFiltersResponseHeaders(t *testing.T) {
	p, _ := newTestProxy(t, okUpstream)
	rec := do(p, http.MethodGet, "/v1/catalog/datacenters", nil)
	h := rec.Header()
	if h.Get("X-Consul-Default-Acl-Policy") != "deny" || h.Get("X-Consul-Results-Filtered-By-Acls") != "true" {
		t.Errorf("consul metadata headers missing: %v", h)
	}
	if h.Get("Set-Cookie") != "" || h.Get("X-Internal-Secret") != "" {
		t.Errorf("unexpected headers forwarded: %v", h)
	}
	if h.Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q", h.Get("Cache-Control"))
	}
	if rec.Body.String() != `["dc1"]` {
		t.Errorf("body = %q", rec.Body)
	}
}

func TestProxyPassesThroughConsulErrors(t *testing.T) {
	p, _ := newTestProxy(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Permission denied", http.StatusForbidden)
	})
	rec := do(p, http.MethodGet, "/v1/internal/ui/services", nil)
	if rec.Code != http.StatusForbidden || rec.Header().Get("X-Console-Blocked") != "" {
		t.Errorf("got %d blocked=%q; Consul 403 must not look like a console block", rec.Code, rec.Header().Get("X-Console-Blocked"))
	}
}

func TestProxyUpstreamUnavailable(t *testing.T) {
	u, _ := url.Parse("http://127.0.0.1:1") // nothing listens on port 1
	p := &Proxy{Upstream: u, Client: http.DefaultClient, Routes: ReadOnlyRoutes, Timeout: time.Second,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	rec := do(p, http.MethodGet, "/v1/catalog/datacenters", nil)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
}

func TestProxyUpstreamTimeout(t *testing.T) {
	p, _ := newTestProxy(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	})
	p.Timeout = 50 * time.Millisecond
	rec := do(p, http.MethodGet, "/v1/catalog/datacenters", nil)
	if rec.Code != http.StatusGatewayTimeout {
		t.Errorf("status = %d, want 504", rec.Code)
	}
}
