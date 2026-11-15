// Command consul-ops-console serves the Consul Operations Console: the web
// UI plus a read-only, allowlisted reverse proxy to the Consul HTTP API.
//
// Configuration is via environment variables; see
// operations-console/README.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/markcampv/consul/operations-console/server/internal/console"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(logger); err != nil {
		logger.Error("fatal", "error", err.Error())
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := console.FromEnv(os.Getenv)
	if err != nil {
		return err
	}
	for _, w := range cfg.Warnings {
		logger.Warn(w)
	}
	if _, err := os.Stat(cfg.WebDir); err != nil {
		logger.Warn("web assets directory not found; the UI will not load until it is built", "dir", cfg.WebDir)
	}

	tlsCfg, err := cfg.TLSConfig()
	if err != nil {
		return err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = tlsCfg
	transport.MaxIdleConnsPerHost = 16
	transport.Proxy = nil // talk to Consul directly, never through an environment proxy

	proxy := &console.Proxy{
		Upstream:  cfg.ConsulAddr,
		Client:    &http.Client{Transport: transport},
		Routes:    console.ReadOnlyRoutes,
		Timeout:   cfg.UpstreamTimeout,
		Logger:    logger,
		UserAgent: "consul-ops-console/" + version,
	}
	handler := console.NewHandler(console.Options{
		Config:  cfg,
		Proxy:   proxy,
		Web:     console.DirFS(cfg.WebDir),
		Version: version,
		Logger:  logger,
	})

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      cfg.UpstreamTimeout + 10*time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	ln, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", cfg.ListenAddr, err)
	}
	logger.Info("console listening", "addr", ln.Addr().String(), "consul", cfg.ConsulAddr.Redacted(),
		"web_dir", cfg.WebDir, "version", version)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		logger.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
	return nil
}
