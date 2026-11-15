/**
 * Map raw Consul API payloads into the provider-neutral domain model.
 * Pure functions only; everything here is unit-tested against fixtures
 * recorded from a real agent.
 */
import { healthFromChecks, normaliseCheckStatus } from '../../domain/health';
import type {
  EvidenceClass,
  EvidenceRecord,
  HealthStatus,
  IntentionDecision,
  Relationship,
  ServiceKind,
  ServiceRef,
  ServiceSummary,
  TopologyGraph,
  TopologyIssue,
  TopologyNode,
} from '../../domain/types';
import type {
  ConsulIntentionDecision,
  ConsulServiceHealthEntry,
  ConsulServiceListing,
  ConsulServiceTopology,
  ConsulTopologySummary,
} from './api-types';
import type { ApiError, ResponseMeta } from './client';

export function serviceId(ref: ServiceRef): string {
  const loc = ref.peer ? `peer:${ref.peer}` : ref.datacenter;
  return [loc, ref.partition || '-', ref.namespace || '-', ref.name].join('/');
}

const KINDS: Record<string, ServiceKind> = {
  '': 'service',
  typical: 'service',
  'connect-proxy': 'connect-proxy',
  'mesh-gateway': 'mesh-gateway',
  'terminating-gateway': 'terminating-gateway',
  'ingress-gateway': 'ingress-gateway',
  'api-gateway': 'api-gateway',
};

export function mapKind(raw: string | undefined): ServiceKind {
  return KINDS[raw ?? ''] ?? 'unknown';
}

export const GATEWAY_KINDS: ReadonlySet<ServiceKind> = new Set([
  'mesh-gateway',
  'terminating-gateway',
  'ingress-gateway',
  'api-gateway',
]);

export function mapServiceListing(s: Omit<ConsulServiceListing, 'Datacenter'> & { Datacenter?: string }, fallbackDc: string): ServiceSummary {
  const ref: ServiceRef = {
    name: s.Name,
    datacenter: s.Datacenter || fallbackDc,
    ...(s.PeerName ? { peer: s.PeerName } : {}),
    ...(s.Partition ? { partition: s.Partition } : {}),
    ...(s.Namespace ? { namespace: s.Namespace } : {}),
  };
  const kind = mapKind(s.Kind);
  const checks = { passing: s.ChecksPassing ?? 0, warning: s.ChecksWarning ?? 0, critical: s.ChecksCritical ?? 0 };
  const summary: ServiceSummary = {
    id: serviceId(ref),
    ref,
    kind,
    rawKind: s.Kind ?? '',
    tags: [...new Set(s.Tags ?? [])].sort(),
    instanceCount: s.InstanceCount ?? 0,
    checks,
    health: healthFromChecks(checks),
    meshEnabled:
      Boolean(s.ConnectedWithProxy) || Boolean(s.ConnectNative) || Boolean(s.TransparentProxy) || GATEWAY_KINDS.has(kind),
    behindGateway: Boolean(s.ConnectedWithGateway),
    transparentProxy: Boolean(s.TransparentProxy),
  };
  const assoc = s.GatewayConfig?.AssociatedServiceCount;
  if (typeof assoc === 'number') summary.gatewayServiceCount = assoc;
  return summary;
}

/** Kinds that `/v1/internal/ui/service-topology` accepts (agent/ui_endpoint.go). */
const TOPOLOGY_KINDS: ReadonlySet<ServiceKind> = new Set(['service', 'ingress-gateway', 'api-gateway']);

/**
 * Services whose topology should be queried to discover every relationship.
 * Every edge has a mesh-enabled downstream, so querying those (plus
 * ingress/API gateways) is sufficient; non-mesh services are reached from
 * the other side.
 */
export function topologyTargets(services: readonly ServiceSummary[]): ServiceSummary[] {
  return services.filter((s) => TOPOLOGY_KINDS.has(s.kind) && (s.kind !== 'service' || s.meshEnabled) && !s.ref.peer);
}

export function topologyKindParam(kind: ServiceKind): string {
  return kind === 'service' ? '' : kind;
}

interface SourceInfo {
  class: EvidenceClass;
  broad: boolean;
  description: string;
}

/** Consul's TopologySource* values (agent/structs/connect_proxy_config.go). */
export const TOPOLOGY_SOURCES: Record<string, SourceInfo> = {
  'proxy-registration': {
    class: 'declared',
    broad: false,
    description: "Declared as an explicit upstream in the downstream's sidecar proxy registration.",
  },
  'routing-config': {
    class: 'discovered',
    broad: false,
    description:
      'The upstream name has no instances of its own and resolves only through discovery-chain configuration (service-router, -splitter or -resolver).',
  },
  'specific-intention': {
    class: 'inferred',
    broad: false,
    description:
      'Not declared. The downstream uses transparent proxy and a specific intention allows the connection, so it can reach this service.',
  },
  'wildcard-intention': {
    class: 'inferred',
    broad: true,
    description:
      'Not declared. The downstream uses transparent proxy and a wildcard intention allows the connection.',
  },
  'default-allow': {
    class: 'inferred',
    broad: true,
    description:
      'Not declared. The downstream uses transparent proxy and the ACL default policy is allow, so it could reach this service.',
  },
};

export function evidenceFor(source: string, reportedBy: string, meta: Pick<ResponseMeta, 'source' | 'fetchedAt'>): EvidenceRecord {
  const info = TOPOLOGY_SOURCES[source] ?? {
    class: 'unknown' as const,
    broad: false,
    description: `Consul reported this relationship with an unrecognised source "${source}". The console does not interpret it.`,
  };
  return {
    class: info.class,
    origin: source || '(none)',
    description: info.description,
    broad: info.broad,
    reportedBy,
    source: meta.source,
    fetchedAt: meta.fetchedAt,
  };
}

export function mapIntention(d: ConsulIntentionDecision | undefined): IntentionDecision | undefined {
  if (!d) return undefined;
  return {
    verdict: d.HasPermissions ? 'conditional' : d.Allowed ? 'allowed' : 'denied',
    match: d.HasExact ? 'exact' : 'wildcard-or-default',
    defaultPolicy: d.DefaultAllow ? 'allow' : 'deny',
    ...(d.ExternalSource ? { externalSource: d.ExternalSource } : {}),
  };
}

export type TopologyResult =
  | { service: ServiceSummary; ok: true; data: ConsulServiceTopology; meta: ResponseMeta }
  | { service: ServiceSummary; ok: false; error: ApiError };

function externalKind(
  entry: ConsulTopologySummary,
  localDc: string
): TopologyNode['external'] {
  if (entry.PeerName) return 'peer';
  if (entry.Datacenter && entry.Datacenter !== localDc) return 'remote';
  if (entry.Source === 'routing-config' && (entry.InstanceCount ?? 0) === 0) return 'virtual';
  return null;
}

/**
 * Merge per-service topology responses into one graph. Both ends of a
 * relationship usually report it (A lists B as upstream, B lists A as
 * downstream); evidence from both perspectives is kept and de-duplicated.
 */
export function buildTopologyGraph(
  services: readonly ServiceSummary[],
  results: readonly TopologyResult[],
  localDc: string,
  fetchedAt: string
): TopologyGraph {
  const nodes = new Map<string, TopologyNode>();
  for (const s of services) {
    if (s.kind === 'connect-proxy') continue;
    nodes.set(s.id, { id: s.id, service: s, external: null });
  }

  const edges = new Map<string, Relationship>();
  const issues: TopologyIssue[] = [];
  let inspected = 0;

  const ensureNode = (entry: ConsulTopologySummary): string => {
    const summary = mapServiceListing(entry, localDc);
    if (!nodes.has(summary.id)) {
      nodes.set(summary.id, { id: summary.id, service: summary, external: externalKind(entry, localDc) });
    }
    return summary.id;
  };

  const addEdge = (from: string, to: string, ev: EvidenceRecord, intention: IntentionDecision | undefined) => {
    const id = `${from}->${to}`;
    let rel = edges.get(id);
    if (!rel) {
      rel = { id, from, to, evidence: [] };
      if (intention) rel.intention = intention;
      edges.set(id, rel);
    } else if (intention) {
      if (!rel.intention) rel.intention = intention;
      else if (rel.intention.verdict !== intention.verdict) rel.intentionConflict = true;
    }
    const key = (e: EvidenceRecord) => `${e.class}|${e.origin}|${e.reportedBy}`;
    if (!rel.evidence.some((e) => key(e) === key(ev))) rel.evidence.push(ev);
  };

  const inspectedIds = new Set<string>();
  const filteredIds = new Set<string>();

  for (const r of results) {
    if (!r.ok) {
      issues.push({
        serviceId: r.service.id,
        kind: r.error.kind === 'forbidden' ? 'forbidden' : 'error',
        message: r.error.detail,
      });
      continue;
    }
    inspected++;
    inspectedIds.add(r.service.id);
    if (r.data.FilteredByACLs) {
      filteredIds.add(r.service.id);
      issues.push({
        serviceId: r.service.id,
        kind: 'filtered-by-acls',
        message: 'Some upstreams or downstreams were hidden because the token lacks read permission for them.',
      });
    }
    const self = r.service.id;
    for (const up of r.data.Upstreams ?? []) {
      const ev = evidenceFor(up.Source, self, r.meta);
      if (r.data.TransparentProxy && up.Source === 'routing-config') {
        // Consul relabels any upstream name that has no instances but has
        // routing config as routing-config, including names a transparent
        // proxy reaches only through intentions (agent/consul/state/catalog.go).
        ev.caveat =
          'The downstream uses transparent proxy, so this target may be reachable through intentions rather than an explicitly declared upstream. Consul labels it routing-config because the name has routing configuration but no instances.';
      }
      addEdge(self, ensureNode(up), ev, mapIntention(up.Intention));
    }
    for (const down of r.data.Downstreams ?? []) {
      addEdge(ensureNode(down), self, evidenceFor(down.Source, self, r.meta), mapIntention(down.Intention));
    }
  }

  annotateOneSidedEdges(edges, nodes, inspectedIds, filteredIds);
  return { nodes, edges, issues, inspected, fetchedAt };
}

const nameOf = (nodes: Map<string, TopologyNode>, id: string) => nodes.get(id)?.service.ref.name ?? id;

/**
 * A relationship reported only by the upstream, while the downstream was
 * inspected and did not list it, cannot be a direct declaration. Consul
 * computes downstreams through compiled discovery chains, so the downstream
 * most likely declared a *different* upstream (e.g. a virtual service with a
 * resolver redirect or splitter) that routes here. Consul still labels these
 * `proxy-registration`, so the console reclassifies them as `discovered` and
 * says why.
 */
function annotateOneSidedEdges(
  edges: Map<string, Relationship>,
  nodes: Map<string, TopologyNode>,
  inspectedIds: ReadonlySet<string>,
  filteredIds: ReadonlySet<string>
) {
  for (const rel of edges.values()) {
    if (!inspectedIds.has(rel.from)) continue;
    if (rel.evidence.some((e) => e.reportedBy === rel.from)) continue;
    const down = nameOf(nodes, rel.from);
    const up = nameOf(nodes, rel.to);
    for (const ev of rel.evidence) {
      if (filteredIds.has(rel.from)) {
        ev.caveat = `Only ${up} reports this relationship. ${down}'s own topology was filtered by ACLs, which may be why it is missing there.`;
      } else if (ev.class === 'declared') {
        ev.reclassifiedFrom = 'declared';
        ev.class = 'discovered';
        ev.description = `Consul lists ${down} as a downstream of ${up} with the label proxy-registration: an upstream that ${down} declared resolves to ${up}.`;
        ev.caveat = `Only ${up} reports this relationship; ${down} does not list ${up} as an upstream. ${down} most likely reaches ${up} through discovery-chain routing (for example a resolver redirect or splitter) from one of its declared upstreams. Inspect ${down}'s discovery chains to confirm.`;
      }
    }
  }
}

export interface ServiceInstance {
  id: string;
  node: string;
  nodeAddress: string;
  address: string;
  port: number;
  tags: string[];
  meta: Record<string, string>;
  health: HealthStatus;
  checks: Array<{ id: string; name: string; status: HealthStatus; output: string; type: string; scope: 'node' | 'service' }>;
  /** Declared upstreams, when this instance is a sidecar proxy. */
  declaredUpstreams: string[];
}

export function mapHealthEntries(entries: readonly ConsulServiceHealthEntry[]): ServiceInstance[] {
  return entries
    .map((e) => {
      const checks = (e.Checks ?? []).map((c) => ({
        id: c.CheckID,
        name: c.Name,
        status: normaliseCheckStatus(c.Status),
        output: c.Output ?? '',
        type: c.Type ?? '',
        scope: c.ServiceID ? ('service' as const) : ('node' as const),
      }));
      const counts = { passing: 0, warning: 0, critical: 0 };
      for (const c of checks) if (c.status !== 'none') counts[c.status]++;
      return {
        id: e.Service.ID,
        node: e.Node.Node,
        nodeAddress: e.Node.Address,
        address: e.Service.Address || e.Node.Address,
        port: e.Service.Port,
        tags: e.Service.Tags ?? [],
        meta: e.Service.Meta ?? {},
        health: healthFromChecks(counts),
        checks,
        declaredUpstreams: (e.Service.Proxy?.Upstreams ?? []).map((u) => u.DestinationName),
      };
    })
    .sort((a, b) => a.node.localeCompare(b.node) || a.id.localeCompare(b.id));
}
