# Consul Operations Console — Architecture Assessment

Status: **Accepted for Milestone 1** · Audited revision: `bc1a625e` (fork `main`, synced with `hashicorp/consul` `main`, Consul `3.0.0-dev`) · Date: 2026-11-14

This document records what the repository actually contains (verified by
reading the code, not assumed), what can be reused, where the limits are, and
the architecture chosen for the Operations Console.

---

## 1. Existing architecture

### 1.1 Repository and versions

| Item | Finding | Where |
|---|---|---|
| Consul version | `3.0.0-dev` | `version/VERSION` |
| Go toolchain | `go 1.26.10` | `go.mod` |
| Root licence | **Business Source License 1.1** (Change Licence MPL 2.0 after 4 years) | `LICENSE` |
| Sub-module licences | `api/`, `sdk/`, `proto-public/` are **MPL-2.0**; `troubleshoot/`, `envoyextensions/` and core are BUSL-1.1 | `*/LICENSE`, SPDX headers |
| Fork relationship | `main` regularly merges `hashicorp:main` | `git log` |

### 1.2 The existing UI (`ui/`)

* **Framework: Ember.js — still.** `ember-source ^5.12`, `ember-data ~4.12`,
  Glimmer components, `ember-cli` build, plus classic-era add-ons
  (`ember-classic-decorator`, `ember-changeset`, mixins). It is a pnpm
  workspace (`ui/pnpm-workspace.yaml`, glob `packages/*`) with a single
  package, `ui/packages/consul-ui` (~630 JS modules, ~305 templates).
* **Design system:** `@hashicorp/design-system-components` v6 /
  `design-system-tokens` v4, plus a large SCSS tree in `app/styles`.
* **Routing:** Ember's router, but route *definitions* are not in
  `router.js`. They are declared as a JSON-ish tree in
  `vendor/consul-ui/routes.js` (and `routes-debug.js`), injected into
  `index.html` as `<script data-routes>` and merged at boot
  (`app/router.js`, `app/routing/route.js`). Routes are datacenter-scoped
  (`/:dc/services/...`), with optional `/:partition/:nspace` prefixes.
* **Data layer:** a bespoke "data-source" system layered over ember-data.
  Adapters (`app/adapters/*.js`) build requests with a tagged-template
  HTTP DSL (``request`GET /v1/... ` ``); repositories
  (`app/services/repository/*.js`) are decorated with `@dataSource('/uri')`;
  `client/http.js` adds `X-Consul-Token` and manages blocking-query long
  polling and connection limits.
* **Auth:** the ACL token is persisted in `localStorage` under
  `consul:token` (JSON with `SecretID`/`AccessorID`) and sent as
  `X-Consul-Token`. Permissions are checked up front via
  `POST /v1/internal/acl/authorize` and modelled with `ember-can` abilities
  (`app/abilities`).
* **Mock API:** `ui/packages/consul-ui/mock-api/` uses
  `@hashicorp/api-double` templates that generate **randomised** data with
  faker. These are good for exploration but not deterministic enough to
  back assertions about topology.
* **Tests:** QUnit unit/integration tests, Yadda/Cucumber-style acceptance
  tests (`tests/acceptance/*.feature`), Playwright e2e against a live agent
  (`e2e-tests/`), `node-tests/` via tape. CI: `.github/workflows/frontend.yml`.

### 1.3 The existing service topology

`app/components/topology-metrics/` renders **one service at a time**: three
columns (downstreams → selected service → upstreams). Connector lines are
computed by measuring DOM element positions with `getBoundingClientRect()`
and drawing SVG paths. There is **no mesh-wide graph**, no zoom/pan, no
search, and the layout is coupled to the DOM. Optional metrics come from the
pluggable metrics-provider (Prometheus) via `/v1/internal/ui/metrics-proxy/`.

### 1.4 How Consul serves the UI

* `agent/uiserver/uiserver.go` embeds `agent/uiserver/dist` with
  `//go:embed dist` and serves it at `ui_config.content_path` (default
  `/ui/`). `ui_config.dir` can override with an on-disk directory.
* `index.html` is rendered as a Go `text/template` with runtime data from
  `ui_template_data.go`: `ACLsEnabled`, `LocalDatacenter`,
  `PrimaryDatacenter`, `PeeringEnabled`, metrics-provider settings. Secrets
  in `metrics_proxy.add_headers` are deliberately **not** passed through.
* A CSP is injected on HTML responses (`default-src 'self'; style-src 'self'
  'unsafe-inline'; script-src 'self'; ... frame-ancestors 'none'`).
* `dist/` is produced by `make ui` / `make ui-regen` and committed by a CI
  job (`embedded-asset-checker.yml`). Contributors are told not to commit it
  by hand.

### 1.5 How the backend exposes operational data

Public, documented endpoints (`/v1/catalog/*`, `/v1/health/*`,
`/v1/config/*`, `/v1/connect/intentions*`, `/v1/discovery-chain/*`,
`/v1/peerings`, `/v1/namespaces` [Enterprise]) plus **internal UI
endpoints** registered in `agent/http_register.go` and implemented in
`agent/ui_endpoint.go`:

| Endpoint | Returns | Notes |
|---|---|---|
| `GET /v1/internal/ui/services` | `ServiceListingSummary[]`: name, kind, instance & check counts, `ConnectedWithProxy`, `ConnectedWithGateway`, `GatewayConfig`, `TransparentProxy`, peer | One call gives the whole catalog summary |
| `GET /v1/internal/ui/service-topology/:name?kind=` | `ServiceTopology`: `Upstreams[]`, `Downstreams[]`, each with **`Source`** and **`Intention`** decision, plus `FilteredByACLs`, `TransparentProxy`, `Protocol` | Only kinds `""`, `ingress-gateway`, `api-gateway` |
| `GET /v1/internal/ui/catalog-overview` | aggregate counts | |
| `GET /v1/internal/ui/gateway-services-nodes/:gw` | services behind a gateway | |
| `GET /v1/internal/ui/gateway-intentions/:gw` | intentions relevant to a gateway | |
| `GET /v1/internal/ui/metrics-proxy/*` | proxied metrics backend | Can carry operator-configured secret headers |

**The `Source` field on topology edges is the single most useful finding.**
`agent/structs/connect_proxy_config.go` defines it as one of:

| `Source` value | Meaning (from the code) |
|---|---|
| `proxy-registration` | Upstream explicitly declared in the sidecar registration |
| `routing-config` | Target produced by discovery-chain config (router/splitter/resolver) with no backing instance |
| `specific-intention` | Reachable because a specific intention allows it (transparent proxy) |
| `wildcard-intention` | Reachable because a wildcard intention allows it |
| `default-allow` | Reachable only because the ACL default policy is `allow` |

These are configuration or inference provenances. **None of them means
traffic was observed.** The console has to keep that distinction visible.

Two subtleties were found by running a real agent
(`operations-console/scripts/seed-dev-mesh.sh`) and confirmed in
`agent/consul/state/catalog.go`. A naive mapping gets both wrong:

1. **Routing through virtual services is reported one-sided and labelled
   `proxy-registration`.** `frontend` declares the upstream `checkout`, and a
   `service-resolver` redirects `checkout` to `payments`. Consul then lists
   `frontend` as a *downstream of `payments`* with source
   `proxy-registration`, while `frontend`'s own upstream list contains only
   `checkout`. The console detects edges reported only by the upstream side,
   when the downstream was inspected and did not report them, and
   reclassifies them as **discovered** with an explicit caveat.
2. **`routing-config` is assigned to any upstream name with no instances
   but with router/splitter/resolver entries**, including names a
   transparent proxy reaches only through intentions (e.g. `audit →
   checkout` under `default-allow`). These edges carry a caveat when the
   reporting service is in transparent-proxy mode.
3. **Splitter targets behind an instance-backed upstream are invisible**
   to the topology API (`payments` splitting 10% to `payments-canary` does
   not produce a `payments-canary` edge). Only `/v1/discovery-chain/:name`
   reveals them, which is a Milestone 3 concern.

Intention summaries (`IntentionDecisionSummary`) also need care:
`DefaultAllow` is the default-policy *mode*, not proof that the default
decided. When `HasExact` is false, either a wildcard intention or the
default decided, and Consul does not say which. With L7 permissions,
`Allowed` is a configured fallback, not a decision. The console models
these as `match: wildcard-or-default` and `verdict: conditional`.

Useful response headers: `X-Consul-Default-ACL-Policy` (on
`/v1/catalog/datacenters`), `X-Consul-Results-Filtered-By-ACLs` (on any
endpoint using `setMeta`), `X-Consul-Index`, `X-Consul-KnownLeader`.

**CORS:** the HTTP API emits no `Access-Control-*` headers (only static
`http_config.response_headers`). A browser application on another origin
cannot call Consul directly. This rules out a purely static, separately
hosted frontend.

### 1.6 Existing extension or customization mechanisms

* `ui_config.dir` — replace the whole UI with on-disk assets.
* `ui_config.content_path` — change the mount path.
* Metrics providers (`ui_config.metrics_provider_files`) — inject JS
  that implements the provider interface.
* `ui_config.dashboard_url_templates` — link-outs to external dashboards.
* `UIDataTransform` in `uiserver` — Enterprise hook for template data.

None of these allows mounting a *second* application next to `/ui/`
without patching `agent/http.go`.

### 1.7 Envoy-related code in the repository

* `troubleshoot/proxy` (BUSL) — validates upstreams against an Envoy
  config dump plus `/clusters` and inspects certificates; powers
  `consul troubleshoot upstreams|proxy`.
* `command/connect/envoy` — bootstrap generation.
* Envoy admin (`:19000`) is never exposed by the Consul HTTP API.

### 1.8 xDSnap (`markcampv/xDSnap`, MIT)

Inspected at its default branch:

* A `kubectl` plugin (cobra) with `capture` and `analyze` sub-commands.
* `capture` runs inside pods through the Kubernetes API and fetches Envoy
  admin `/stats`, `/config_dump`, `/listeners`, `/clusters`, `/certs`, plus
  logs and an optional `tcpdump` ephemeral container, then writes a
  `.tar.gz` bundle.
* `analyze` loads a bundle and runs deterministic rules
  (`envoy.no_healthy_upstream`, `envoy.unknown_cluster`,
  `consul.acl.permission_denied`, `xds.stream_closed`,
  `tls.certificate_expiry`, `envoy.route.missing_cluster`, …) that emit an
  `AnalyzeReport` of `Finding{id, severity, confidence, summary,
  hypothesis, evidence[], recommended_actions[]}` and an optional
  `Graph{nodes, edges}`.
* All code lives in `package cmd` (`pkg/cmd`), so it is **not importable
  as a library** without refactoring.

xDSnap's `Finding` already has the evidence-first shape the console's
diagnostics need. The cleanest integration is **report import**: the
console ingests `AnalyzeReport` JSON. No runtime coupling and no Envoy admin
exposure are involved. See §4.5.

---

## 2. Reusable components and APIs

| Reuse | How |
|---|---|
| `/v1/internal/ui/services` | Catalog summary in one request (MVP). |
| `/v1/internal/ui/service-topology/:name` | Edge source **with provenance** and intention decisions (MVP). |
| `/v1/health/service/:name` | Per-instance checks (MVP). |
| `/v1/catalog/datacenters` + `X-Consul-Default-ACL-Policy` | Datacenter switcher, default-policy context (MVP). |
| `X-Consul-Results-Filtered-By-ACLs` | Honest "you are seeing a partial view" banners (MVP). |
| `/v1/discovery-chain/:name`, `/v1/config/:kind` | Config explorer and routing diagnostics (M3). |
| `POST /v1/internal/acl/authorize` | Read-only permission probing for ACL-aware diagnostics (M4). Needs a deliberate proxy allowlist exception. |
| `github.com/hashicorp/consul/api` (MPL-2.0) | Typed Go client for future server-side aggregation. Licence-compatible with a permissively licensed console. |
| `troubleshoot/proxy` logic | Reference for Envoy upstream validation rules. **BUSL**: do not copy into a differently licensed console; re-derive or call the CLI. |
| Ember components | **Not reused.** They are tied to Ember, HDS and BUSL. |

---

## 3. Architectural limitations

1. **No mesh-wide topology API.** `service-topology` is per service. A
   mesh graph needs N requests (one per mesh-enabled service and
   ingress/API gateway). That is fine for tens to low hundreds of services,
   but at scale it needs server-side aggregation and caching.
2. **Internal endpoints are unstable.** `/v1/internal/ui/*` has no
   compatibility guarantee. The console must isolate them behind one
   provider module and test against fixtures recorded from real agents.
3. **No observed-traffic data in Consul.** Live traffic needs Envoy stats
   (via xDSnap or a metrics backend). Consul's APIs only prove
   configuration and intention state.
4. **No CORS.** A same-origin proxy is mandatory.
5. **Edition differences.** Namespaces and partitions are Enterprise-only.
   `/v1/namespaces` returns 404 on CE, so capability detection is required.
6. **Ember UI coupling.** The topology component, data-source DSL and
   route-JSON system are idiosyncratic. Extending them means deep Ember
   expertise, a heavy dependency tree (node 24, HDS) and merge conflicts
   every time `hashicorp:main` is pulled.
7. **Licensing.** Anything derived from `ui/` or core is BUSL-1.1. For a
   console that is "independently useful open source", new code has to
   stay clear of BUSL-derived code (see DECISIONS.md, ADR-007).

---

## 4. Recommended implementation strategy

### 4.1 Options compared

| Criterion | **A. Extend Ember UI** | **B. New React SPA only** | **C. Hybrid: independent console + thin Go server** |
|---|---|---|---|
| Maintainability | Low. Bespoke data-source DSL, classic patterns, HDS coupling | Medium. Clean code, but no place for trusted logic | **High.** Clean SPA, small Go server with a narrow job |
| Development velocity | Slow. Ember expertise, 1–2k-package install, node 24 | Fast | **Fast.** Same SPA velocity; server is ~400 lines |
| Compatibility with upstream merges | **Poor.** Every edit to `ui/` conflicts with upstream | Good if isolated | **Excellent.** New top-level dir; zero upstream files touched |
| Compatibility with Consul | Native | Blocked by missing CORS without a proxy | Same-origin via proxy; works with any Consul ≥ 1.10-era UI APIs |
| Security | Inherits Consul UI model | Token in browser, but **cannot reach Consul** cross-origin | **Strongest.** Server enforces read-only allowlist, strips secrets, never accepts arbitrary targets, keeps Envoy admin off the browser |
| Testing complexity | High (QUnit + Yadda + page objects) | Low | Low–medium (Vitest + Go `httptest` + Playwright) |
| Long-term extensibility | Bound to Consul's release train and BUSL | Limited: diagnostics, Envoy collection and history need a backend | **High.** Server grows aggregation, diagnostics, xDSnap import and snapshots behind explicit endpoints |
| Licence flexibility | BUSL only | Flexible | **Flexible** (uses only the public HTTP API; optional MPL `api` client) |

### 4.2 Recommendation: Option C, delivered incrementally

**Supplement, don't replace.** The existing Ember UI stays untouched and
keeps shipping at `/ui/`. The Operations Console is a new, independent
application in `operations-console/`:

```
Browser ──► console server (Go, same origin) ──► Consul HTTP API (/v1/…)
              │  • serves SPA static assets
              │  • read-only allowlisted reverse proxy (GET/HEAD only)
              │  • forwards only X-Consul-Token; strips ?token=, cookies
              │  • fixed upstream from server config (no SSRF)
              │  • future: aggregation, diagnostics, xDSnap import, snapshots
```

Why it's incremental:

* **M1 (this change):** the server is a thin proxy and all logic is pure
  TypeScript in the browser, so the domain model is easy to unit-test.
* **M2+:** server-side aggregation is added only where the browser can't
  do the job well: mesh-wide topology at scale, cached snapshots, scoped
  Envoy collection. Each one becomes a new `/console/api/...` endpoint.
* **Optional deep integration later:** if upstream acceptance is ever
  wanted, the console can be mounted inside the agent behind a
  `ui_config` flag. That's a small, isolated patch to `agent/http.go`,
  deferred until the console has proven itself (ADR-002).

### 4.3 Domain model (provider-neutral, Consul-first)

The frontend never renders raw Consul JSON. A Consul provider module maps
API responses into a small domain model:

* `ServiceRef { name, datacenter, namespace?, partition?, peer? }` → stable `id`
* `ServiceNode { ref, kind, health, checks, instanceCount, meshEnabled, external }`
* `Relationship { from, to, evidence: EvidenceRecord[], intention? }`
* `EvidenceRecord { class, origin, perspective, api, observedAt }`, where
  `class ∈ declared | discovered | inferred | observed | unknown`

Consul `Source` → evidence class:

| Source | Class | Rationale |
|---|---|---|
| `proxy-registration` | **declared** | An operator wrote it in a registration |
| `routing-config` | **discovered** | Derived from discovery-chain config entries |
| `specific-intention`, `wildcard-intention`, `default-allow` | **inferred** | Possible because policy permits it (transparent proxy); not declared |
| *(anything else)* | **unknown** | Forward-compatible; never silently promoted |
| *(none in M1)* | **observed** | Reserved for Envoy stats/xDSnap/metrics evidence |

### 4.4 Topology visualization technology

| Option | Verdict |
|---|---|
| **React Flow (`@xyflow/react`)** | **Chosen.** Mature pan/zoom/selection, keyboard-accessible nodes, custom node/edge components, MIT licence. |
| ELK.js | Excellent layered layout with orthogonal routing, but about 1.5 MB and best run in a Worker. **Deferred to M2.** The M1 layout sits behind a `layoutGraph()` function so ELK can drop in. |
| D3 | Reserved for bespoke visuals (sparklines, timelines). A force layout is a poor fit for directional dependency graphs. |

M1 ships a small deterministic **layered layout**: cycle-tolerant
longest-path ranking, then barycentre ordering. Edges that skip ranks are
split through dummy nodes, so each one gets its own empty slot and never
runs behind an unrelated service. That bug was visible in an early build:
`frontend → payments` looked like `frontend → api`. The layout is a pure
function with unit tests. Unconnected services go in a separate grid so
they don't add visual noise.

### 4.5 xDSnap / Envoy integration (design, not M1)

* `EnvoyEvidenceSource` interface in the console server. The first
  implementation is **report import**: an uploaded xDSnap `AnalyzeReport`
  (and optionally the bundle) is parsed server-side. Findings attach to
  services by pod/service metadata and appear as `observed` evidence with
  the original confidence and source file.
* Live collection (xDSnap `capture` triggered from the console) needs
  Kubernetes credentials, explicit per-request authorization, a scope
  (namespace/pod), and an audit record. **Envoy admin endpoints are never
  proxied to the browser.**
* Longer term: refactor xDSnap so `pkg/analyze` is importable
  (MIT → compatible), and the console server can run the same rules
  in-process.

### 4.6 Diagnostics engine (design, M3)

Deterministic checks implemented as `Check` units:
`(input) → Result{status, observation, evidence[], sourceAPI, observedAt,
verification: confirmed|inferred|unknown, nextSteps[]}`.
Results never claim a root cause. They report observations and how strong
the evidence is. AI explanation, if it ever comes, consumes these results;
it doesn't replace them.

---

## 5. Risks and compatibility considerations

| Risk | Mitigation |
|---|---|
| Internal UI APIs change shape | Isolated in `src/providers/consul/`; fixtures recorded from a real agent; defensive parsing with unknown-value fallbacks. |
| N+1 topology fan-out on large meshes | Bounded concurrency (6), partial-failure reporting, only mesh-enabled services queried; server-side aggregation in M2. |
| Token handling in the browser | Session storage by default (opt-in persistence), header-only transport, server never logs headers/query, `?token=` stripped. |
| Proxy becomes an open relay / SSRF | Upstream fixed by server config; method and path allowlist; path traversal rejected; only `/v1/` allowlisted prefixes. |
| Privilege laundering via a server-side token | **Not supported.** The server never injects its own ACL token (ADR-005). |
| Sensitive data exposure | KV, ACL, agent, operator, snapshot, event and metrics-proxy endpoints are **excluded** from the allowlist. |
| Enterprise vs CE | Capability probing (`/v1/namespaces` 404 → CE). No Enterprise assumptions. |
| Licence ambiguity | Console code is original and depends only on the HTTP API. Licence choice is an open decision for the maintainer (ADR-007). |
| Upstream merges | No edits to upstream-owned paths. `ui/` and core are untouched. |

---

## 6. Proposed repository structure

```
operations-console/
├── README.md                 # quick start, env vars, security model
├── Makefile                  # dev / test / build / docker
├── Dockerfile                # multi-stage: web build → Go build → distroless
├── scripts/
│   ├── seed-dev-mesh.sh      # registers a representative mesh in a LOCAL dev agent
│   └── record-fixtures.mjs   # records real API responses as test/mock fixtures
├── server/                   # Go module (independent go.mod, stdlib only)
│   ├── go.mod
│   ├── main.go               # env config, http.Server, graceful shutdown
│   └── internal/console/
│       ├── config.go         # env parsing & validation, TLS, Host allowlist
│       ├── proxy.go          # read-only allowlisted reverse proxy
│       └── server.go         # mux, SPA handler, security headers, config.json
└── web/                      # React + TypeScript + Vite
    ├── package.json
    ├── vite.config.ts        # dev proxy to Consul, or deterministic mock mode
    ├── playwright.config.ts  # mock mode by default; E2E_BASE_URL for live
    ├── e2e/                  # Playwright specs
    └── src/
        ├── domain/           # provider-neutral types, health, graph filter, layout (pure)
        ├── providers/consul/ # API client, raw types, mappers, data access, hooks, fixtures
        ├── features/         # overview, services (+gateways), topology, settings
        ├── components/       # shared badges and state views
        ├── lib/              # small utilities (bounded concurrency)
        └── app/              # shell, routing, theme/token settings
```

Docs live in `docs/operations-console/` (this file, `ROADMAP.md`,
`DECISIONS.md`).

---

## 7. Development and testing strategy

| Layer | Tooling | Runs where |
|---|---|---|
| Domain transforms, layout, mappers | Vitest (pure functions) | `make -C operations-console test-web` |
| Components | Vitest + Testing Library + jsdom | same |
| Proxy security rules | Go `testing` + `httptest` | `make -C operations-console test-server` |
| End-to-end smoke | Playwright against Vite **mock mode** (deterministic fixtures) | `pnpm -C operations-console/web e2e` |
| Integration | Real `consul agent -dev` seeded by `scripts/seed-dev-mesh.sh` → console server → the same Playwright specs | `make -C operations-console e2e-live` (manual today; nightly CI in M2) |
| Fixture recording | `scripts/record-fixtures.mjs` captures real responses from a seeded agent into `web/src/providers/consul/fixtures/demo.json` | `make -C operations-console fixtures` |
| Version compatibility | Fixture sets recorded per Consul version (M2) | CI matrix |

Development modes:

* `pnpm dev:mock` — no Consul needed; deterministic demo mesh.
* `pnpm dev` — Vite proxies `/v1` to `CONSUL_HTTP_ADDR` (default `http://127.0.0.1:8500`).
* `go run ./server` — production-like serving of `web/dist` + proxy.
