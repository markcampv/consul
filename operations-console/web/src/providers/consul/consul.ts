/**
 * Consul data access: the only module that knows which endpoints exist.
 * Returns domain types plus response metadata (ACL filtering, timestamps,
 * source API) so the UI can show evidence and partial-visibility warnings.
 */
import type { ServiceSummary, TopologyGraph } from '../../domain/types';
import { mapWithConcurrency } from '../../lib/concurrency';
import type { ConsulServiceHealthEntry, ConsulServiceListing, ConsulServiceTopology } from './api-types';
import { ApiError, type ConsulClient, type ResponseMeta } from './client';
import {
  buildTopologyGraph,
  mapHealthEntries,
  mapServiceListing,
  topologyKindParam,
  topologyTargets,
  type ServiceInstance,
  type TopologyResult,
} from './mappers';

/** Maximum concurrent per-service topology requests. */
export const TOPOLOGY_CONCURRENCY = 6;

export interface Datacenters {
  datacenters: string[];
  defaultACLPolicy?: 'allow' | 'deny';
  meta: ResponseMeta;
}

export async function fetchDatacenters(client: ConsulClient, signal?: AbortSignal): Promise<Datacenters> {
  const res = await client.get<string[]>('/v1/catalog/datacenters', {}, signal);
  return { datacenters: res.data, defaultACLPolicy: res.meta.defaultACLPolicy, meta: res.meta };
}

export interface Leader {
  leader: string;
  meta: ResponseMeta;
}

export async function fetchLeader(client: ConsulClient, dc: string, signal?: AbortSignal): Promise<Leader> {
  const res = await client.get<string>('/v1/status/leader', { dc }, signal);
  return { leader: res.data, meta: res.meta };
}

export interface Capabilities {
  /** Enterprise namespaces API available (404 "not a recognized endpoint" on Community Edition). */
  namespaces: boolean;
}

export async function detectCapabilities(client: ConsulClient, signal?: AbortSignal): Promise<Capabilities> {
  try {
    await client.get<unknown>('/v1/namespaces', {}, signal);
    return { namespaces: true };
  } catch (e) {
    if (e instanceof ApiError && (e.kind === 'unsupported' || e.kind === 'not-found' || e.kind === 'blocked')) {
      return { namespaces: false };
    }
    // Forbidden means the endpoint exists but the token cannot list namespaces.
    if (e instanceof ApiError && e.kind === 'forbidden') return { namespaces: true };
    throw e;
  }
}

export interface ServiceCatalog {
  /** Excludes sidecar proxies (they are shown as part of their service). */
  services: ServiceSummary[];
  /** Including sidecars, for topology construction. */
  all: ServiceSummary[];
  meta: ResponseMeta;
}

export async function fetchServices(client: ConsulClient, dc: string, signal?: AbortSignal): Promise<ServiceCatalog> {
  const res = await client.get<ConsulServiceListing[]>('/v1/internal/ui/services', { dc }, signal);
  const all = (res.data ?? []).map((s) => mapServiceListing(s, dc));
  return { all, services: all.filter((s) => s.kind !== 'connect-proxy'), meta: res.meta };
}

export async function fetchServiceTopology(
  client: ConsulClient,
  service: ServiceSummary,
  dc: string,
  signal?: AbortSignal
): Promise<TopologyResult> {
  try {
    const res = await client.get<ConsulServiceTopology>(
      `/v1/internal/ui/service-topology/${encodeURIComponent(service.ref.name)}`,
      { dc, kind: topologyKindParam(service.kind), ns: service.ref.namespace, partition: service.ref.partition },
      signal
    );
    return { service, ok: true, data: res.data, meta: res.meta };
  } catch (e) {
    if (e instanceof ApiError) return { service, ok: false, error: e };
    throw e;
  }
}

/**
 * Build the mesh-wide graph by querying each mesh-enabled service's topology.
 * Consul has no mesh-wide topology endpoint, so this is O(mesh services)
 * requests with bounded concurrency. Individual failures (e.g. 403) become
 * graph issues instead of failing the whole view.
 */
export async function fetchMeshTopology(
  client: ConsulClient,
  catalog: ServiceCatalog,
  dc: string,
  signal?: AbortSignal,
  now: () => Date = () => new Date()
): Promise<TopologyGraph> {
  const targets = topologyTargets(catalog.services);
  const results = await mapWithConcurrency(targets, TOPOLOGY_CONCURRENCY, (svc) =>
    fetchServiceTopology(client, svc, dc, signal)
  );
  return buildTopologyGraph(catalog.services, results, dc, now().toISOString());
}

export interface ServiceInstances {
  instances: ServiceInstance[];
  meta: ResponseMeta;
}

export async function fetchServiceInstances(
  client: ConsulClient,
  name: string,
  dc: string,
  signal?: AbortSignal
): Promise<ServiceInstances> {
  const res = await client.get<ConsulServiceHealthEntry[]>(
    `/v1/health/service/${encodeURIComponent(name)}`,
    { dc },
    signal
  );
  return { instances: mapHealthEntries(res.data ?? []), meta: res.meta };
}
