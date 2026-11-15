# Consul Operations Console

A read-only operations console for HashiCorp Consul. It lets you explore
services, see the mesh topology with the **evidence behind every
relationship**, and spot unhealthy services and their dependencies,
without stitching together CLI output.

It runs alongside Consul's built-in UI and doesn't replace or modify it.
Design and rationale: [`docs/operations-console/`](../docs/operations-console/).

## What it shows (and what it doesn't)

* Services, instances and checks, filterable and linkable.
* Topology from Consul's service-topology data. Each line is labelled:
  * **Declared**: an explicit upstream in a sidecar registration.
  * **Discovered**: derived from discovery-chain routing configuration.
  * **Inferred**: possible because intentions or the default ACL policy allow it (transparent proxy).
* Intention verdicts on each relationship, including when Consul can't say
  whether a wildcard or the default policy decided.
* **No observed traffic.** Consul's configuration APIs don't report live
  traffic, and the console never pretends otherwise.

## Quick start

Requirements: Node ≥ 20.19 with pnpm, Go ≥ 1.24, and optionally a `consul`
binary.

```bash
cd operations-console/web && pnpm install
```

No Consul needed (deterministic recorded data):

```bash
make -C operations-console dev-mock    # http://127.0.0.1:5173
```

Against a local dev agent with a demo mesh:

```bash
consul agent -dev
```

```bash
make -C operations-console seed        # registers demo services (local agents only)
```

```bash
make -C operations-console dev         # Vite proxies /v1 to CONSUL_HTTP_ADDR
```

Production-like (Go server + built assets):

```bash
make -C operations-console run         # http://127.0.0.1:9500
```

Container (listens on all interfaces, so set the allowed host names):

```bash
make -C operations-console docker
```

```bash
docker run --rm -p 9500:9500 -e CONSUL_HTTP_ADDR=http://host.docker.internal:8500 -e CONSOLE_ALLOWED_HOSTS=localhost consul-ops-console:dev
```

## Configuration (console server)

| Variable | Default | Purpose |
|---|---|---|
| `CONSUL_HTTP_ADDR` | `http://127.0.0.1:8500` | Consul HTTP API (URL or `host:port`) |
| `CONSUL_HTTP_SSL` | `false` | Use HTTPS when `CONSUL_HTTP_ADDR` has no scheme |
| `CONSUL_CACERT` | — | CA bundle for Consul's TLS certificate |
| `CONSUL_CLIENT_CERT` / `CONSUL_CLIENT_KEY` | — | mTLS client certificate for Consul |
| `CONSUL_TLS_SERVER_NAME` | — | SNI / verification name |
| `CONSUL_HTTP_SSL_VERIFY` | `true` | `false` disables verification (warned) |
| `CONSOLE_LISTEN_ADDR` | `127.0.0.1:9500` | Listen address |
| `CONSOLE_ALLOWED_HOSTS` | loopback only | Accepted `Host` names (DNS-rebinding protection) |
| `CONSOLE_WEB_DIR` | `web/dist` | Built UI assets |
| `CONSOLE_CLUSTER_NAME` | `consul` | Label shown in the UI |
| `CONSOLE_UPSTREAM_TIMEOUT` | `30s` | Per-request timeout to Consul |

`CONSUL_HTTP_TOKEN` is **ignored on purpose**: each user enters their own
ACL token in **Settings**, so Consul enforces their permissions. Browsing
needs `service:read` and `node:read`.

Development only: `pnpm dev` reads `CONSUL_HTTP_ADDR` and
`CONSOLE_DEV_PORT`.

## Security model

* The server forwards **only `GET`/`HEAD`** to an **allowlist** of Consul
  endpoints (`server/internal/console/proxy.go`). KV, ACL, agent, operator,
  snapshot, config entries and the metrics proxy are blocked.
* The upstream is fixed by server configuration. Browsers can't choose
  hosts.
* Only `X-Consul-Token` is forwarded. `?token=`, cookies and
  `Authorization` are stripped. Logs contain method, path, status and
  duration only.
* Strict CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, and a
  `Host` allowlist.
* Envoy admin endpoints are never reachable through the console.

## Tests

```bash
make -C operations-console test        # tsc + Vitest (web), gofmt/vet/go test -race (server)
```

```bash
make -C operations-console e2e         # Playwright against mock mode
```

```bash
make -C operations-console e2e-live    # same specs against a running console + seeded dev agent
```

To refresh fixtures after changing the seed scenario:

```bash
make -C operations-console fixtures
```

## Layout

```
scripts/   seed-dev-mesh.sh, record-fixtures.mjs
server/    Go console server (stdlib only, separate module)
web/       React + TypeScript + Vite app
  src/domain/            provider-neutral model, graph filtering, layout
  src/providers/consul/  API client, mappers, data access, fixtures
  src/features/          overview, services, topology, settings
```

## Licence

Not yet decided. See ADR-007 in `docs/operations-console/DECISIONS.md`.
Until then this directory falls under the repository's licence.
