package console

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

// Route is one allowlisted Consul API endpoint.
type Route struct {
	// Path is matched exactly, or as a prefix when Prefix is true. A prefix
	// route requires a non-empty remainder (e.g. a service name).
	Path   string
	Prefix bool
}

// ReadOnlyRoutes are the only Consul endpoints the console forwards. The list
// follows least privilege: it contains exactly what the UI uses today.
//
// Deliberately excluded (do not add without a security review):
//   - /v1/kv/*, /v1/acl/*, /v1/agent/*, /v1/operator/*, /v1/snapshot,
//     /v1/event/*: secrets, credentials, or cluster-control surfaces
//   - /v1/internal/ui/metrics-proxy/*: may carry operator-configured secret headers
//   - /v1/config/*: inline-certificate entries contain private keys; needs a
//     redacting handler before it can be exposed (ROADMAP M3)
//   - anything that reaches Envoy admin endpoints
var ReadOnlyRoutes = []Route{
	{Path: "/v1/catalog/datacenters"},
	{Path: "/v1/status/leader"},
	{Path: "/v1/namespaces"},
	{Path: "/v1/internal/ui/services"},
	{Path: "/v1/internal/ui/service-topology/", Prefix: true},
	{Path: "/v1/health/service/", Prefix: true},
}

// Response headers passed back to the browser. Everything else is dropped.
var forwardedResponseHeaders = []string{
	"Content-Type",
	"X-Consul-Index",
	"X-Consul-Knownleader",
	"X-Consul-Lastcontact",
	"X-Consul-Default-Acl-Policy",
	"X-Consul-Results-Filtered-By-Acls",
	"X-Consul-Effective-Consistency",
}

// Proxy forwards allowlisted, read-only requests to Consul.
type Proxy struct {
	Upstream *url.URL
	Client   *http.Client
	Routes   []Route
	Timeout  time.Duration
	Logger   *slog.Logger
	// UserAgent identifies the console to Consul.
	UserAgent string
}

func blocked(w http.ResponseWriter, status int, reason, msg string) {
	w.Header().Set("X-Console-Blocked", reason)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, msg+"\n")
}

// allowed reports whether a cleaned request path matches an allowlisted route.
func (p *Proxy) allowed(reqPath string) bool {
	for _, r := range p.Routes {
		if !r.Prefix && reqPath == r.Path {
			return true
		}
		if r.Prefix && strings.HasPrefix(reqPath, r.Path) && len(reqPath) > len(r.Path) {
			return true
		}
	}
	return false
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	status := 0
	defer func() {
		// Never log headers or the query string: they can contain tokens.
		p.Logger.Info("proxy", "method", r.Method, "path", r.URL.Path, "status", status,
			"duration_ms", time.Since(start).Milliseconds())
	}()

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		status = http.StatusMethodNotAllowed
		w.Header().Set("Allow", "GET, HEAD")
		blocked(w, status, "method", "The operations console is read-only.")
		return
	}

	// Reject anything that is not already in canonical form. This catches
	// "..", "//", and encoded separators (e.g. %2F) that decode into them.
	reqPath := r.URL.Path
	if reqPath == "" || path.Clean(reqPath) != reqPath || strings.ContainsAny(reqPath, "\x00\\") ||
		strings.Contains(strings.ToLower(r.URL.RawPath), "%2f") {
		status = http.StatusBadRequest
		blocked(w, status, "path", "Path is not in canonical form.")
		return
	}
	if !p.allowed(reqPath) {
		status = http.StatusForbidden
		blocked(w, status, "path", "This Consul endpoint is not on the console's read-only allowlist.")
		return
	}

	// Tokens travel only in the X-Consul-Token header; drop ?token= so they
	// never appear in Consul's access logs or URLs.
	q := r.URL.Query()
	q.Del("token")
	target := *p.Upstream
	target.Path = reqPath
	target.RawPath = r.URL.RawPath
	target.RawQuery = q.Encode()

	ctx, cancel := context.WithTimeout(r.Context(), p.Timeout)
	defer cancel()
	out, err := http.NewRequestWithContext(ctx, r.Method, target.String(), nil)
	if err != nil {
		status = http.StatusBadRequest
		blocked(w, status, "path", "Invalid request.")
		return
	}
	// Build headers from scratch: cookies, Authorization and forwarding
	// headers from the browser are never sent to Consul.
	out.Header.Set("Accept", "application/json")
	out.Header.Set("User-Agent", p.UserAgent)
	if tok := r.Header.Get("X-Consul-Token"); tok != "" {
		out.Header.Set("X-Consul-Token", tok)
	}

	resp, err := p.Client.Do(out)
	if err != nil {
		status = http.StatusBadGateway
		msg := "The console server could not reach Consul."
		if errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
			msg = "Consul did not respond before the console's upstream timeout."
		}
		if r.Context().Err() != nil {
			status = 499 // client went away; nothing to write
			return
		}
		p.Logger.Warn("upstream error", "path", reqPath, "error", err.Error())
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, msg+"\n")
		return
	}
	defer resp.Body.Close()

	for _, h := range forwardedResponseHeaders {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	status = resp.StatusCode
	w.WriteHeader(resp.StatusCode)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, resp.Body)
	}
}
