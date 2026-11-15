package console

import (
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestFromEnvDefaults(t *testing.T) {
	c, err := FromEnv(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.ListenAddr != "127.0.0.1:9500" || c.ConsulAddr.String() != "http://127.0.0.1:8500" ||
		c.UpstreamTimeout != 30*time.Second || c.ClusterName != "consul" || len(c.Warnings) != 0 {
		t.Errorf("unexpected defaults: %+v", c)
	}
}

func TestFromEnvConsulAddrForms(t *testing.T) {
	for in, want := range map[string]string{
		"consul.service:8500":      "http://consul.service:8500",
		"https://consul.lab:8501":  "https://consul.lab:8501",
		"https://consul.lab:8501/": "https://consul.lab:8501",
	} {
		c, err := FromEnv(env(map[string]string{"CONSUL_HTTP_ADDR": in}))
		if err != nil || c.ConsulAddr.String() != want {
			t.Errorf("%s -> %v, %v; want %s", in, c, err, want)
		}
	}
	c, _ := FromEnv(env(map[string]string{"CONSUL_HTTP_ADDR": "consul:8501", "CONSUL_HTTP_SSL": "true"}))
	if c.ConsulAddr.Scheme != "https" {
		t.Errorf("CONSUL_HTTP_SSL not honoured")
	}
	for _, bad := range []string{"ftp://x", "http://x:8500/ui", "://"} {
		if _, err := FromEnv(env(map[string]string{"CONSUL_HTTP_ADDR": bad})); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestFromEnvIgnoresServerTokenWithWarning(t *testing.T) {
	c, err := FromEnv(env(map[string]string{"CONSUL_HTTP_TOKEN": "s3cr3t"}))
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(c.Warnings, "\n")
	if !strings.Contains(joined, "ignored") || strings.Contains(joined, "s3cr3t") {
		t.Errorf("warnings = %q", joined)
	}
}

func TestFromEnvValidation(t *testing.T) {
	cases := []map[string]string{
		{"CONSUL_CLIENT_CERT": "cert.pem"},
		{"CONSOLE_UPSTREAM_TIMEOUT": "-1s"},
		{"CONSUL_HTTP_SSL_VERIFY": "maybe"},
	}
	for _, m := range cases {
		if _, err := FromEnv(env(m)); err == nil {
			t.Errorf("%v accepted", m)
		}
	}
}

func TestFromEnvWarnsOnExposedListenerWithoutHosts(t *testing.T) {
	c, _ := FromEnv(env(map[string]string{"CONSOLE_LISTEN_ADDR": "0.0.0.0:9500"}))
	if len(c.Warnings) == 0 {
		t.Error("expected DNS-rebinding warning")
	}
	c, _ = FromEnv(env(map[string]string{"CONSOLE_LISTEN_ADDR": "0.0.0.0:9500", "CONSOLE_ALLOWED_HOSTS": "Console.Lab, other"}))
	if len(c.Warnings) != 0 || c.AllowedHosts[0] != "console.lab" {
		t.Errorf("hosts=%v warnings=%v", c.AllowedHosts, c.Warnings)
	}
}

func TestTLSConfig(t *testing.T) {
	c, _ := FromEnv(env(nil))
	if tc, err := c.TLSConfig(); err != nil || tc != nil {
		t.Errorf("plain http should need no TLS config: %v %v", tc, err)
	}
	c, _ = FromEnv(env(map[string]string{"CONSUL_HTTP_ADDR": "https://x:8501", "CONSUL_HTTP_SSL_VERIFY": "false"}))
	tc, err := c.TLSConfig()
	if err != nil || tc == nil || !tc.InsecureSkipVerify {
		t.Errorf("tls = %+v %v", tc, err)
	}
	c, _ = FromEnv(env(map[string]string{"CONSUL_CACERT": "/does/not/exist.pem"}))
	if _, err := c.TLSConfig(); err == nil {
		t.Error("missing CA file accepted")
	}
}
