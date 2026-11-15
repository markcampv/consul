# Operations Console — Roadmap

Principles: ship read-only value first, keep evidence and uncertainty
visible, and add a server-side capability only when the browser can't do
the job safely or efficiently. See [ARCHITECTURE.md](ARCHITECTURE.md) and
[DECISIONS.md](DECISIONS.md).

---

## M1 — Read-only vertical slice ✅ (this change)

**Scope**

* App shell: navigation, light/dark/system theme, responsive layout,
  keyboard shortcuts (`/` search, `g t|s|o|w`), skip link.
* Consul integration: datacenters, services, health, per-instance checks,
  leader, ACL default policy, CE/Enterprise capability probe,
  `X-Consul-Results-Filtered-By-ACLs` banners, and error guidance for
  401/403/404/5xx/network/blocked.
* Service explorer: searchable and filterable catalog (URL-shareable),
  gateway list, service detail with instances, checks and evidence-backed
  upstreams and downstreams.
* Topology: mesh-wide graph, evidence-class filters, broad-policy
  inferences opt-in and counted, focus and neighbourhood dimming,
  node/edge detail panels, denied-intention styling, a legend stating that
  no line is observed traffic.
* Console server: read-only allowlisted proxy, Host check, security
  headers, TLS to Consul, distroless image.
* Tooling: seed script, fixture recorder, Vitest, Go tests, Playwright
  (mock and live).

**Acceptance criteria (all met and verified)**

| Criterion | Evidence |
|---|---|
| Connects to a local Consul | Playwright suite passes against `consul agent -dev` through the console server |
| Shows services and health | `ServicesPage.test.tsx`, e2e “service catalog…” |
| Renders topology with known dependencies | `mappers.test.ts` (real fixtures), `flow.test.ts`, e2e “topology…” |
| Distinguishes configured from observed | Evidence classes; `evidenceFor` never yields `observed`; legend and copy |
| Respects ACLs | Token pass-through; 403 → guidance; filtered-by-ACL banners; partial topology issues |
| Handles unavailable APIs | CE `/v1/namespaces` 404 → capability off; unreachable → guidance |
| Dark mode | e2e “theme toggle…” |
| No Consul core changes | `git status` shows only `operations-console/` and `docs/operations-console/` |

**Known limitations**

* Namespace and partition *filtering* is not implemented. Enterprise is
  detected but untested (no licence available). IDs and queries already
  carry `ns`/`partition`.
* Topology fan-out is one request per mesh service (ADR-006).
* Peered and remote-datacenter upstreams are modelled
  (`external: peer|remote`) but not exercised by the fixtures.
* The container image is defined but was not built in the authoring
  environment (no Docker daemon).

---

## M2 — Scale, gateways and multi-datacenter

**Goals.** Make topology fast on large meshes and make gateways and
cross-DC paths first-class.

| Item | Notes |
|---|---|
| `GET /console/api/v1/topology?dc=` | Server-side aggregation with `github.com/hashicorp/consul/api` (MPL-2.0), bounded concurrency, blocking-query cache, ETag. The browser makes one request. |
| Gateway relationships | `gateway-services-nodes`, terminating-gateway linked services, mesh-gateway mode per upstream; gateways shown as nodes with typed edges. |
| Multi-DC and peering view | `/v1/peerings` status, exported services, remote upstream nodes grouped by DC/peer. |
| Namespace/partition filters | Capability-gated UI; Enterprise test fixtures. |
| ELK.js layout in a Worker | Only if layout quality or performance demands it (ADR-004). |
| Nightly live e2e in CI | Spin up `consul agent -dev`, seed, run `make e2e-live`. |
| Fixture matrix | Record fixtures per supported Consul version, and run the mapper tests against each. |

**Risks.** Internal UI endpoints changing shape (mitigated by the fixture
matrix). Cache invalidation correctness (use `X-Consul-Index`).

**Proposed file changes.** `server/internal/topology/` (new),
`server/internal/console/proxy.go` (no allowlist change needed),
`web/src/providers/consul/consul.ts` (switch to the aggregated endpoint
when available).

---

## M3 — Connectivity diagnostics and configuration explorer

**Goals.** Answer “why can’t A reach B?” with evidence.

| Item | Notes |
|---|---|
| Diagnostic engine (Go) | `Check` units producing `{status, observation, evidence[], sourceAPI, observedAt, verification, nextSteps}`. Deterministic, unit-tested, no AI. |
| Initial checks | Source/destination registration and health; upstream declared or inferred; intention verdict and match; discovery chain compiles and targets have healthy instances; splitter/resolver targets (fixes the invisible `payments-canary` gap); mesh-gateway mode; peering status. |
| Path explorer | Expected path `A → sidecar → [mesh GW → remote mesh GW] → B` with evidence per hop, labelled *expected*, not *verified*. |
| Config explorer | Read-only `/v1/config/:kind` through a **redacting** handler (`inline-certificate` private keys, JWT provider secrets). JSON/YAML viewer. |
| Cross-DC config diff | Structural diff with “intentional vs suspicious” hints, never verdicts. |

**Risks.** Over-claiming root causes. Mitigated by the evidence model, a
mandatory `verification` field, and copy review.

---

## M4 — Envoy evidence (xDSnap) and ACL-aware diagnostics

| Item | Notes |
|---|---|
| xDSnap report import | Upload `AnalyzeReport` JSON (and optionally the bundle). Findings attach to services as `observed` evidence with the original confidence. No live Envoy access. |
| xDSnap library refactor (upstream PR to xDSnap) | Move rules from `pkg/cmd` to an importable `pkg/analyze` so the console server can run them in-process. |
| Scoped live capture | Optional Kubernetes provider: explicit per-request authorization, namespace/pod scope, audit log entry, results stored server-side only. **Envoy admin is never exposed to browsers.** |
| ACL diagnostics | `POST /v1/internal/acl/authorize` (read-only semantics). Requires a reviewed allowlist exception. |
| SSO | Consul OIDC auth methods for token acquisition. |

---

## M5 — History, drift and safe operations

| Item | Notes |
|---|---|
| Snapshots | `TopologyGraph` and config entries serialised with `fetchedAt`. Pluggable storage (filesystem first; no database until needed). |
| Time machine | Diff two snapshots: services added/removed, edges whose evidence changed, intention verdict changes, endpoint counts. |
| Write operations (design first) | Intentions and config entries only, behind a feature flag. Flow: dry-run diff → explicit confirmation (typed name for destructive ops) → apply with the user’s token → verify by re-reading → audit event. A separate ADR is required before implementation. |
| Incident bundle export | Sanitised JSON/Markdown with topology slice, diagnostics, evidence, notes. Redaction rules unit-tested. |

---

## Cross-cutting

* **Compatibility.** CE first, with Enterprise features capability-gated.
  The Consul versions supported are defined by the fixture matrix.
* **Testing.** Every mapper and diagnostic has fixture-based tests. Security
  rules have Go tests. User journeys have Playwright specs runnable in both
  mock and live modes.
* **Security reviews.** Required for any allowlist change, any write path,
  and any new evidence collector.
