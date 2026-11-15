import { useSearchParams } from 'react-router';
import { useDatacenters } from '../providers/consul/queries';

/**
 * The selected datacenter lives in the URL (`?dc=`) so views are shareable.
 * Without it, the first datacenter Consul returns is used (Consul sorts the
 * list by estimated round-trip time, so the local datacenter comes first).
 */
export function useDatacenter() {
  const [params] = useSearchParams();
  const query = useDatacenters();
  const requested = params.get('dc') ?? undefined;
  const list = query.data?.datacenters ?? [];
  const dc = requested ?? list[0];
  const unknown = Boolean(requested && query.data && !list.includes(requested));
  return { dc, datacenters: list, query, unknown };
}

/** Append the current `dc` to a link so navigation keeps the datacenter. */
export function useDcLink() {
  const [params] = useSearchParams();
  const dc = params.get('dc');
  return (path: string, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams(extra);
    if (dc) q.set('dc', dc);
    const s = q.toString();
    return s ? `${path}?${s}` : path;
  };
}
