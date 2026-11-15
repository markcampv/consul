package console

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func testHandler(t *testing.T, cfg *Config) http.Handler {
	t.Helper()
	web := fstest.MapFS{
		"index.html":          {Data: []byte("<!doctype html><title>console</title>")},
		"assets/index-abc.js": {Data: []byte("console.log(1)")},
		"favicon.svg":         {Data: []byte("<svg/>")},
	}
	proxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "proxied "+r.URL.Path)
	})
	return NewHandler(Options{Config: cfg, Proxy: proxy, Web: web, Version: "test",
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
}

func loopbackCfg() *Config { return &Config{ListenAddr: "127.0.0.1:9500", ClusterName: "lab"} }

func get(h http.Handler, target, host string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestSPARoutingAndHeaders(t *testing.T) {
	h := testHandler(t, loopbackCfg())

	for _, p := range []string{"/", "/topology", "/services/payments"} {
		rec := get(h, p, "localhost:9500")
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "<title>console</title>") {
			t.Errorf("%s: %d %q", p, rec.Code, rec.Body)
		}
		if rec.Header().Get("Content-Security-Policy") != ContentSecurityPolicy {
			t.Errorf("%s: CSP missing", p)
		}
		if rec.Header().Get("X-Frame-Options") != "DENY" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: security headers missing", p)
		}
	}

	rec := get(h, "/assets/index-abc.js", "127.0.0.1:9500")
	if rec.Code != 200 || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Errorf("asset: %d cache=%q", rec.Code, rec.Header().Get("Cache-Control"))
	}
	if rec := get(h, "/assets/missing.js", "localhost"); rec.Code != 404 {
		t.Errorf("missing asset = %d, want 404", rec.Code)
	}
	if rec := get(h, "/v1/catalog/datacenters", "localhost"); rec.Body.String() != "proxied /v1/catalog/datacenters" {
		t.Errorf("proxy not mounted: %q", rec.Body)
	}
	if rec := get(h, "/healthz", "localhost"); rec.Code != 200 {
		t.Errorf("healthz = %d", rec.Code)
	}
}

func TestConfigJSONExposesNoSecrets(t *testing.T) {
	cfg := loopbackCfg()
	cfg.CACert = "/secret/ca.pem"
	rec := get(testHandler(t, cfg), "/console/config.json", "localhost")
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["clusterName"] != "lab" || body["readOnly"] != true {
		t.Errorf("unexpected config: %v", body)
	}
	if strings.Contains(rec.Body.String(), "secret") || strings.Contains(rec.Body.String(), "8500") {
		t.Errorf("config leaks internals: %s", rec.Body)
	}
}

func TestHostCheckBlocksDNSRebinding(t *testing.T) {
	h := testHandler(t, loopbackCfg())
	if rec := get(h, "/v1/catalog/datacenters", "attacker.example:9500"); rec.Code != http.StatusMisdirectedRequest {
		t.Errorf("foreign Host on loopback listener = %d, want 421", rec.Code)
	}
	for _, host := range []string{"localhost:9500", "127.0.0.1:9500", "[::1]:9500"} {
		if rec := get(h, "/healthz", host); rec.Code != 200 {
			t.Errorf("Host %s = %d", host, rec.Code)
		}
	}

	cfg := &Config{ListenAddr: "0.0.0.0:9500", AllowedHosts: []string{"console.internal"}}
	h = testHandler(t, cfg)
	if rec := get(h, "/healthz", "console.internal:9500"); rec.Code != 200 {
		t.Errorf("allowed host = %d", rec.Code)
	}
	if rec := get(h, "/healthz", "localhost"); rec.Code != http.StatusMisdirectedRequest {
		t.Errorf("unlisted host = %d", rec.Code)
	}
}

func TestSPARejectsWrites(t *testing.T) {
	h := testHandler(t, loopbackCfg())
	req := httptest.NewRequest(http.MethodPost, "/topology", nil)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d", rec.Code)
	}
}
