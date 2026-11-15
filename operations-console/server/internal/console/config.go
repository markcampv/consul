package console

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the console server configuration. It is read from the
// environment (see FromEnv); there is deliberately no way for a browser to
// change the upstream Consul address.
type Config struct {
	// ListenAddr is the address the console listens on (CONSOLE_LISTEN_ADDR).
	ListenAddr string
	// ConsulAddr is the Consul HTTP API base URL (CONSUL_HTTP_ADDR).
	ConsulAddr *url.URL
	// TLS settings for the connection to Consul (CONSUL_CACERT, ...).
	CACert, ClientCert, ClientKey, TLSServerName string
	InsecureSkipVerify                           bool
	// WebDir holds the built SPA (CONSOLE_WEB_DIR).
	WebDir string
	// ClusterName is shown in the UI (CONSOLE_CLUSTER_NAME).
	ClusterName string
	// UpstreamTimeout bounds each proxied request (CONSOLE_UPSTREAM_TIMEOUT).
	UpstreamTimeout time.Duration
	// AllowedHosts restricts the Host header to defend against DNS rebinding
	// (CONSOLE_ALLOWED_HOSTS, comma separated). When empty and the console
	// listens on loopback, only loopback host names are accepted.
	AllowedHosts []string
	// Warnings collected while parsing, logged at startup.
	Warnings []string
}

// FromEnv builds a Config from environment variables, using the same names
// as the Consul CLI where they overlap.
func FromEnv(getenv func(string) string) (*Config, error) {
	get := func(k, def string) string {
		if v := strings.TrimSpace(getenv(k)); v != "" {
			return v
		}
		return def
	}
	c := &Config{
		ListenAddr:    get("CONSOLE_LISTEN_ADDR", "127.0.0.1:9500"),
		CACert:        getenv("CONSUL_CACERT"),
		ClientCert:    getenv("CONSUL_CLIENT_CERT"),
		ClientKey:     getenv("CONSUL_CLIENT_KEY"),
		TLSServerName: getenv("CONSUL_TLS_SERVER_NAME"),
		WebDir:        get("CONSOLE_WEB_DIR", "web/dist"),
		ClusterName:   get("CONSOLE_CLUSTER_NAME", "consul"),
	}

	addr := get("CONSUL_HTTP_ADDR", "http://127.0.0.1:8500")
	if !strings.Contains(addr, "://") {
		scheme := "http"
		if ssl, _ := strconv.ParseBool(getenv("CONSUL_HTTP_SSL")); ssl {
			scheme = "https"
		}
		addr = scheme + "://" + addr
	}
	u, err := url.Parse(addr)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("CONSUL_HTTP_ADDR %q must be an http(s) URL or host:port", addr)
	}
	if u.Path != "" && u.Path != "/" {
		return nil, fmt.Errorf("CONSUL_HTTP_ADDR %q must not contain a path", addr)
	}
	u.Path = ""
	c.ConsulAddr = u

	if v := getenv("CONSUL_HTTP_SSL_VERIFY"); v != "" {
		verify, err := strconv.ParseBool(v)
		if err != nil {
			return nil, fmt.Errorf("CONSUL_HTTP_SSL_VERIFY: %w", err)
		}
		c.InsecureSkipVerify = !verify
		if !verify {
			c.Warnings = append(c.Warnings, "CONSUL_HTTP_SSL_VERIFY=false: TLS certificates from Consul are NOT verified")
		}
	}

	c.UpstreamTimeout = 30 * time.Second
	if v := getenv("CONSOLE_UPSTREAM_TIMEOUT"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return nil, fmt.Errorf("CONSOLE_UPSTREAM_TIMEOUT %q must be a positive duration", v)
		}
		c.UpstreamTimeout = d
	}

	for _, h := range strings.Split(getenv("CONSOLE_ALLOWED_HOSTS"), ",") {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			c.AllowedHosts = append(c.AllowedHosts, h)
		}
	}
	if len(c.AllowedHosts) == 0 && !isLoopbackListen(c.ListenAddr) {
		c.Warnings = append(c.Warnings, "listening on a non-loopback address without CONSOLE_ALLOWED_HOSTS: any Host header is accepted (DNS-rebinding protection disabled)")
	}

	if (c.ClientCert == "") != (c.ClientKey == "") {
		return nil, errors.New("CONSUL_CLIENT_CERT and CONSUL_CLIENT_KEY must be set together")
	}

	// The console never injects its own ACL token: doing so would give every
	// browser user that token's privileges. Tokens come from the user.
	if getenv("CONSUL_HTTP_TOKEN") != "" || getenv("CONSUL_HTTP_TOKEN_FILE") != "" {
		c.Warnings = append(c.Warnings, "CONSUL_HTTP_TOKEN/CONSUL_HTTP_TOKEN_FILE is ignored: users supply their own ACL token in the UI")
	}
	return c, nil
}

func isLoopbackListen(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// HostAllowed reports whether a request's Host header is acceptable.
func (c *Config) HostAllowed(hostHeader string) bool {
	host := strings.ToLower(hostHeader)
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if len(c.AllowedHosts) > 0 {
		for _, a := range c.AllowedHosts {
			if a == host {
				return true
			}
		}
		return false
	}
	if isLoopbackListen(c.ListenAddr) {
		if host == "localhost" {
			return true
		}
		ip := net.ParseIP(host)
		return ip != nil && ip.IsLoopback()
	}
	return true
}

// TLSConfig returns the client TLS configuration for talking to Consul, or
// nil when the defaults apply.
func (c *Config) TLSConfig() (*tls.Config, error) {
	if c.ConsulAddr.Scheme != "https" && c.CACert == "" && c.ClientCert == "" {
		return nil, nil
	}
	t := &tls.Config{
		MinVersion:         tls.VersionTLS12,
		ServerName:         c.TLSServerName,
		InsecureSkipVerify: c.InsecureSkipVerify, //nolint:gosec // explicit opt-in, warned at startup
	}
	if c.CACert != "" {
		pem, err := os.ReadFile(c.CACert)
		if err != nil {
			return nil, fmt.Errorf("reading CONSUL_CACERT: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("CONSUL_CACERT contains no PEM certificates")
		}
		t.RootCAs = pool
	}
	if c.ClientCert != "" {
		pair, err := tls.LoadX509KeyPair(c.ClientCert, c.ClientKey)
		if err != nil {
			return nil, fmt.Errorf("loading client certificate: %w", err)
		}
		t.Certificates = []tls.Certificate{pair}
	}
	return t, nil
}
