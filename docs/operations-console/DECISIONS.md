# Operations Console — Architecture Decision Records

Each record gives the decision, its context, the alternatives considered,
and the consequences. Status values: **Accepted**, **Proposed** (needs a
maintainer decision), **Superseded**.

---

## ADR-001 · Supplement the Ember UI with an independent console

**Status:** Accepted · 2026-11-14

**Context.** The existing UI (`ui/packages/consul-ui`) is Ember 5.12 with a
bespoke data-source layer, route definitions injected as JSON, the
HashiCorp Design System, about 630 JS modules and about 305 templates. Its topology view
handles one service at a time and draws lines from DOM measurements. The
fork merges `hashicorp:main` regularly.

**Decision.** Build a new console in `operations-console/` with React and
TypeScript, served by a small Go server. Leave `ui/` and every
upstream-owned path untouched.

**Alternatives.** (A) Extend Ember: slow, conflicts on every upstream merge,
BUSL-bound, and needs specialised expertise. (B) A frontend only: blocked
by the missing CORS support, and no place for trusted logic.

**Consequences.** Zero merge conflicts with upstream, and modern tooling.
Some features already in the Ember UI (KV, ACL management, intentions
editing) are not duplicated. The console targets operations and
diagnostics, not administration.

---

## ADR-002 · Same-origin Go server with a read-only allowlist proxy

**Status:** Accepted · 2026-11-14

**Context.** Consul's HTTP API sends no CORS headers, and future features
(Envoy evidence, snapshots, aggregation) need a trusted backend. Mounting
the console inside the Consul agent would mean patching `agent/http.go`.

**Decision.** `operations-console/server` serves the SPA and proxies
`/v1/…` to a single upstream fixed by `CONSUL_HTTP_ADDR`. The proxy:

* accepts only `GET` and `HEAD`;
* forwards only allowlisted endpoints, which in M1 are exactly what the UI
  uses;
* rejects non-canonical paths (`..`, `//`, encoded `/`);
* forwards only `X-Consul-Token` and strips `?token=`, cookies,
  `Authorization` and forwarding headers;
* returns only `Content-Type` and `X-Consul-*` metadata headers, with
  `Cache-Control: no-store`;
* logs method, path, status and duration, never query strings or headers;
* checks `Host` against an allowlist (loopback by default) to defeat DNS
  rebinding.

**Consequences.** One extra process to run, but deployment is simple:
a single static binary plus assets, and a distroless image. Embedding the
console in the agent is deferred until the console proves its value. It
would be a small, flag-gated `ui_config` change.

---

## ADR-003 · Evidence classes instead of "edges"

**Status:** Accepted · 2026-11-14

**Context.** A configured upstream does not prove traffic. Consul's
topology API labels relationships with a `Source` that ranges from explicit
declarations to "anything is allowed by default".

**Decision.** Every relationship carries `EvidenceRecord`s with a class
(`declared | discovered | inferred | observed | unknown`), the raw origin,
the reporting service, the source API, the fetch time, and an optional
caveat. `observed` is reserved for telemetry and is never derived from
configuration. Broad-policy inferences (`default-allow`,
`wildcard-intention`) are hidden by default and counted rather than
silently dropped.

**Consequences.** The UI can always answer "why is this line here?".
Edges reported only by the upstream side are reclassified from declared to
discovered, with the reason shown and the original label kept
(`reclassifiedFrom`). This is a deliberate interpretation and is tested
against recorded real data.

---

## ADR-004 · React Flow with a small in-house layered layout

**Status:** Accepted · 2026-11-14

**Context.** Interactive graph needs: pan/zoom, selection, keyboard focus,
custom nodes. Layout needs: directional (downstream → upstream),
cycle-tolerant, deterministic.

**Decision.** `@xyflow/react` for rendering and interaction. The layout is
a pure `routedLayeredLayout()`:

1. longest-path ranking, ignoring back edges;
2. dummy nodes for edges that skip ranks;
3. barycentre ordering;
4. waypoints rendered by a custom edge.

**Alternatives.** ELK.js has better quality and orthogonal routing, but is
about 1.5 MB and best run in a Worker. It is deferred until meshes of more
than about 150 services need it. D3-force is non-deterministic and poor for
directed dependency graphs.

**Consequences.** No layout dependency, and the layout is fully
unit-tested. Swapping in ELK later only changes the implementation of
`routedLayeredLayout`.

---

## ADR-005 · Users bring their own ACL token; the server never injects one

**Status:** Accepted · 2026-11-14

**Context.** A server-side token would give every browser user that token's
privileges, which launders privilege and breaks per-user auditing in
Consul.

**Decision.** The browser sends the user's token as `X-Consul-Token`. It is
stored in `sessionStorage`, or in `localStorage` only on explicit opt-in.
`CONSUL_HTTP_TOKEN` on the server is ignored, with a startup warning.
Changing the token resets all cached data.

**Consequences.** Consul remains the authorization authority. Shared
deployments need users to have tokens, which is the correct trade-off for
an operations tool. SSO/OIDC login (Consul auth methods) is planned for M4.

---

## ADR-006 · Fan-out topology in the browser for M1

**Status:** Accepted for M1 · revisit in M2

**Context.** There is no mesh-wide topology endpoint.
`/v1/internal/ui/service-topology/:name` costs one request per service.

**Decision.** Query only services that can be downstreams: mesh-enabled
services, and ingress and API gateways. Use a concurrency limit of 6.
Individual failures (for example a 403) become visible graph issues rather
than failing the whole view.

**Consequences.** Fine for tens to low hundreds of services. M2 moves the
aggregation into the console server, with blocking-query caching, so that
large meshes need one browser request.

---

## ADR-007 · Licensing of console code

**Status:** **Proposed: maintainer decision required**

**Context.** The repository root is BUSL-1.1. The Consul `api/`, `sdk/` and
`proto-public/` modules are MPL-2.0. xDSnap is MIT. The console's stated
goal is to be "independently useful open source".

**Facts.** The console contains no code copied from `ui/` or Consul core. It
talks to Consul only over the public HTTP API and depends on no Consul Go
packages. Its third-party dependencies are permissive (MIT/Apache-2.0/ISC).

**Options.**

1. Leave it under the repository's BUSL-1.1 (default if nothing is done).
2. Add `operations-console/LICENSE` with MPL-2.0 or Apache-2.0, and say so
   in its README.
3. Move the console to its own repository. This is cleanest for an
   independent OSS project, and the code is already self-contained (own
   `go.mod`, own `package.json`).

**Recommendation.** Option 3, or option 2 as a step towards it. This needs
the maintainer's decision, and legal review if in doubt. No licence file
was added in this change.

---

## ADR-008 · Deterministic fixtures recorded from a real agent

**Status:** Accepted · 2026-11-14

**Context.** The Ember UI's mock API generates random data with faker. That
is unsuitable for asserting topology semantics.

**Decision.** `scripts/seed-dev-mesh.sh` builds a representative mesh.
`scripts/record-fixtures.mjs` records the real responses, with indexes
normalised and no tokens. Unit tests, component tests, Vite mock mode and
Playwright all use the same fixture file. The same Playwright specs also
run against a live agent (`make e2e-live`).

**Consequences.** Tests exercise real response shapes, including CE's 404 on
`/v1/namespaces`. Fixtures must be re-recorded when the seed scenario
changes, and later per supported Consul version.

---

## ADR-009 · Minimal dependency set

**Status:** Accepted · 2026-11-14

Runtime dependencies: `react`, `react-dom`, `react-router`,
`@tanstack/react-query` (caching, retries, request cancellation) and
`@xyflow/react`. The Go server uses only the standard library.

Evaluated and **not** adopted for M1:

* **Tailwind + shadcn/ui.** A few dozen components didn't justify a CSS
  framework, Radix primitives and generated component code. Plain CSS with
  design tokens gives light and dark themes in one file. Revisit if the
  component count grows (dialogs, comboboxes, command palette).
* **Zustand.** Shared state is the URL (dc, focus, filters), React Query's
  cache, and one settings context.
* **MSW.** The Vite middleware and `fixtureFetch` cover mocking without a
  service worker.
* **ELK.js, D3.** See ADR-004.
