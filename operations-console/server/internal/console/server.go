package console

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strings"
)

// ContentSecurityPolicy for the SPA. 'unsafe-inline' styles are required by
// React Flow, which positions nodes with inline style attributes; scripts
// are same-origin only.
const ContentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; " +
	"frame-ancestors 'none'; form-action 'self'"

// Options assemble the console HTTP handler.
type Options struct {
	Config  *Config
	Proxy   http.Handler
	Web     fs.FS
	Version string
	Logger  *slog.Logger
}

// NewHandler returns the console's root handler:
//
//	/v1/...               read-only Consul proxy
//	/console/config.json  non-sensitive UI configuration
//	/healthz              liveness (does not contact Consul)
//	everything else       the single-page app, with index.html fallback
func NewHandler(o Options) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/v1/", o.Proxy)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/console/config.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"clusterName": o.Config.ClusterName,
			"mode":        "server",
			"readOnly":    true,
			"version":     o.Version,
		})
	})
	mux.Handle("/", spaHandler(o.Web, o.Logger))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !o.Config.HostAllowed(r.Host) {
			http.Error(w, "Host not allowed", http.StatusMisdirectedRequest)
			return
		}
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		mux.ServeHTTP(w, r)
	})
}

// spaHandler serves built assets and falls back to index.html for client-side
// routes (paths without a file extension).
func spaHandler(web fs.FS, logger *slog.Logger) http.Handler {
	files := http.FileServerFS(web)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" || name == "index.html" {
			serveIndex(w, r, web, logger)
			return
		}
		if st, err := fs.Stat(web, name); err == nil && !st.IsDir() {
			if strings.HasPrefix(name, "assets/") {
				// Vite emits content-hashed file names under assets/.
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			files.ServeHTTP(w, r)
			return
		}
		if path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
		serveIndex(w, r, web, logger)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request, web fs.FS, logger *slog.Logger) {
	b, err := fs.ReadFile(web, "index.html")
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			logger.Error("index.html not found; build the web app (pnpm -C web build) or set CONSOLE_WEB_DIR")
		}
		http.Error(w, "Console UI assets are missing. Build them with `make -C operations-console build`.", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Security-Policy", ContentSecurityPolicy)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(b)
}

// DirFS is os.DirFS, exposed for main.
func DirFS(dir string) fs.FS { return os.DirFS(dir) }
