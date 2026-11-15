/**
 * Provider-neutral domain model for the Operations Console.
 *
 * UI components depend on these types, never on raw Consul API payloads.
 * Provider modules (today only `providers/consul`) map API responses into
 * them. Keep this file free of Consul-specific field names.
 */

/** Aggregated health. `none` means no checks are registered, so health is unknown, not good. */
export type HealthStatus = 'passing' | 'warning' | 'critical' | 'none';

export interface CheckCounts {
  passing: number;
  warning: number;
  critical: number;
}

/** Identifies a service across datacenters, peers, partitions and namespaces. */
export interface ServiceRef {
  name: string;
  datacenter: string;
  /** Set when the service is imported from a cluster peer. */
  peer?: string;
  /** Enterprise only; undefined on Community Edition. */
  partition?: string;
  /** Enterprise only; undefined on Community Edition. */
  namespace?: string;
}

export type ServiceKind =
  | 'service'
  | 'connect-proxy'
  | 'mesh-gateway'
  | 'terminating-gateway'
  | 'ingress-gateway'
  | 'api-gateway'
  | 'unknown';

export interface ServiceSummary {
  id: string;
  ref: ServiceRef;
  kind: ServiceKind;
  /** The raw kind string from the provider, kept for display when `kind` is `unknown`. */
  rawKind: string;
  tags: string[];
  instanceCount: number;
  checks: CheckCounts;
  health: HealthStatus;
  /** Has a sidecar proxy, is connect-native, or is a gateway. */
  meshEnabled: boolean;
  /** Reached through a terminating gateway. */
  behindGateway: boolean;
  transparentProxy: boolean;
  /** For gateways: services associated with this gateway (terminating/ingress). */
  gatewayServiceCount?: number;
}

/**
 * How strongly a relationship between two services is supported.
 *
 * - declared:   an operator explicitly configured it (e.g. a sidecar upstream)
 * - discovered: derived from routing configuration (e.g. a discovery chain)
 * - inferred:   possible because policy permits it (e.g. transparent proxy + allow)
 * - observed:   traffic was actually seen (Envoy stats, metrics). Never produced
 *               from configuration APIs.
 * - unknown:    the provider reported a relationship we cannot classify
 */
export type EvidenceClass = 'declared' | 'discovered' | 'inferred' | 'observed' | 'unknown';

/** Ordered from strongest to weakest support for "this dependency exists". */
export const EVIDENCE_STRENGTH: readonly EvidenceClass[] = [
  'observed',
  'declared',
  'discovered',
  'inferred',
  'unknown',
];

export interface EvidenceRecord {
  class: EvidenceClass;
  /** Provider-specific origin label, e.g. Consul's `proxy-registration`. */
  origin: string;
  /** Short explanation of what the origin means. */
  description: string;
  /** True when the origin is a broad policy (default-allow, wildcard) rather than a specific one. */
  broad: boolean;
  /** Which end of the relationship reported this evidence. */
  reportedBy: string;
  /** API the evidence came from, e.g. `GET /v1/internal/ui/service-topology/api`. */
  source: string;
  /** When the evidence was fetched (ISO-8601). Not the time the config changed. */
  fetchedAt: string;
  /**
   * Why this evidence should be read with care, e.g. when the provider's label
   * and the surrounding facts disagree. Shown verbatim to the user.
   */
  caveat?: string;
  /** Set when the console changed `class` from the provider's raw label; records the original. */
  reclassifiedFrom?: EvidenceClass;
}

/**
 * - allowed / denied: connection-level decision
 * - conditional: the matching intention has L7 permissions, so the outcome
 *   depends on each request and cannot be decided for the connection
 */
export type IntentionVerdict = 'allowed' | 'denied' | 'conditional';

export interface IntentionDecision {
  verdict: IntentionVerdict;
  /**
   * `exact`: an intention naming both services decided it.
   * `wildcard-or-default`: either a wildcard intention or the default policy
   * decided it. Consul's summary does not say which, so neither is claimed.
   */
  match: 'exact' | 'wildcard-or-default';
  /** The ACL default policy in effect when no intention matches. */
  defaultPolicy: 'allow' | 'deny';
  /** Intention is managed externally (e.g. Kubernetes CRD). */
  externalSource?: string;
}

export interface Relationship {
  id: string;
  /** Downstream (caller) service id. */
  from: string;
  /** Upstream (callee) service id. */
  to: string;
  evidence: EvidenceRecord[];
  intention?: IntentionDecision;
  /** Set when the two ends reported conflicting intention decisions. */
  intentionConflict?: boolean;
}

export interface TopologyNode {
  id: string;
  service: ServiceSummary;
  /** Not in the local catalog listing: another datacenter, a peer, or a virtual (routing-only) service. */
  external: 'remote' | 'peer' | 'virtual' | null;
}

export interface TopologyIssue {
  serviceId: string;
  message: string;
  kind: 'forbidden' | 'error' | 'filtered-by-acls';
}

export interface TopologyGraph {
  nodes: Map<string, TopologyNode>;
  edges: Map<string, Relationship>;
  /** Services whose relationships could not be fully determined. */
  issues: TopologyIssue[];
  /** Number of services whose relationships were queried successfully. */
  inspected: number;
  fetchedAt: string;
}
