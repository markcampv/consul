/**
 * React data hooks for Consul. Query keys are scoped by datacenter; the
 * whole cache is reset when the ACL token changes (see App.tsx).
 */
import { createContext, useContext } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConsulClient } from './client';
import {
  detectCapabilities,
  fetchDatacenters,
  fetchLeader,
  fetchMeshTopology,
  fetchServiceInstances,
  fetchServices,
} from './consul';

export const ConsulClientContext = createContext<ConsulClient | null>(null);

export function useConsulClient(): ConsulClient {
  const c = useContext(ConsulClientContext);
  if (!c) throw new Error('useConsulClient must be used inside ConsulClientContext');
  return c;
}

export const queryKeys = {
  datacenters: () => ['datacenters'] as const,
  capabilities: () => ['capabilities'] as const,
  leader: (dc: string) => ['leader', dc] as const,
  services: (dc: string) => ['services', dc] as const,
  topology: (dc: string) => ['topology', dc] as const,
  instances: (dc: string, name: string) => ['instances', dc, name] as const,
};

export function useDatacenters() {
  const client = useConsulClient();
  return useQuery({ queryKey: queryKeys.datacenters(), queryFn: ({ signal }) => fetchDatacenters(client, signal) });
}

export function useCapabilities() {
  const client = useConsulClient();
  return useQuery({
    queryKey: queryKeys.capabilities(),
    queryFn: ({ signal }) => detectCapabilities(client, signal),
    staleTime: Infinity,
  });
}

export function useLeader(dc: string | undefined) {
  const client = useConsulClient();
  return useQuery({
    queryKey: queryKeys.leader(dc ?? ''),
    queryFn: ({ signal }) => fetchLeader(client, dc!, signal),
    enabled: Boolean(dc),
  });
}

export function useServices(dc: string | undefined) {
  const client = useConsulClient();
  return useQuery({
    queryKey: queryKeys.services(dc ?? ''),
    queryFn: ({ signal }) => fetchServices(client, dc!, signal),
    enabled: Boolean(dc),
  });
}

export function useMeshTopology(dc: string | undefined) {
  const client = useConsulClient();
  const qc = useQueryClient();
  return useQuery({
    queryKey: queryKeys.topology(dc ?? ''),
    queryFn: async ({ signal }) => {
      const catalog = await qc.fetchQuery({
        queryKey: queryKeys.services(dc!),
        queryFn: ({ signal: s }) => fetchServices(client, dc!, s),
      });
      return fetchMeshTopology(client, catalog, dc!, signal);
    },
    enabled: Boolean(dc),
  });
}

export function useServiceInstances(dc: string | undefined, name: string) {
  const client = useConsulClient();
  return useQuery({
    queryKey: queryKeys.instances(dc ?? '', name),
    queryFn: ({ signal }) => fetchServiceInstances(client, name, dc!, signal),
    enabled: Boolean(dc && name),
  });
}

export interface ConsoleConfig {
  clusterName: string;
  mode: string;
  readOnly: boolean;
}

/** Served by the console server (or Vite dev server); never by Consul. */
export function useConsoleConfig() {
  return useQuery({
    queryKey: ['console-config'],
    queryFn: async ({ signal }): Promise<ConsoleConfig> => {
      const res = await fetch('/console/config.json', { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ConsoleConfig;
    },
    staleTime: Infinity,
    retry: false,
  });
}
