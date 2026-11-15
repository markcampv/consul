import { useDeferredValue, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useDatacenter, useDcLink } from '../../app/useDatacenter';
import { HealthBadge, Tag, kindLabel } from '../../components/Badges';
import { EmptyState, ErrorState, FetchedAt, FilteredByACLsNotice, Loading, PageHeader } from '../../components/States';
import { HEALTH_LABEL, compareHealth } from '../../domain/health';
import type { HealthStatus, ServiceSummary } from '../../domain/types';
import { GATEWAY_KINDS } from '../../providers/consul/mappers';
import { useServices } from '../../providers/consul/queries';

const HEALTH_FILTERS: HealthStatus[] = ['critical', 'warning', 'passing', 'none'];

export function matchesSearch(s: ServiceSummary, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return s.ref.name.toLowerCase().includes(needle) || s.tags.some((t) => t.toLowerCase().includes(needle));
}

export function sortServices(list: ServiceSummary[]): ServiceSummary[] {
  return [...list].sort((a, b) => compareHealth(a.health, b.health) || a.ref.name.localeCompare(b.ref.name));
}

export function MeshCell({ s }: { s: ServiceSummary }) {
  if (GATEWAY_KINDS.has(s.kind)) return <Tag tone="info">{kindLabel(s.kind)}</Tag>;
  if (s.transparentProxy) return <Tag tone="info" title="Sidecar in transparent proxy mode">Sidecar · tproxy</Tag>;
  if (s.meshEnabled) return <Tag tone="info">Sidecar</Tag>;
  if (s.behindGateway) return <Tag title="Reachable from the mesh through a terminating gateway">Via gateway</Tag>;
  return <span className="muted">Not in mesh</span>;
}

export function ServiceTable({ services, dcLink }: { services: ServiceSummary[]; dcLink: (p: string) => string }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Health</th>
            <th scope="col" className="num">
              Instances
            </th>
            <th scope="col">Mesh</th>
            <th scope="col">Tags</th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => (
            <tr key={s.id}>
              <td>
                <Link to={dcLink(`/services/${encodeURIComponent(s.ref.name)}`)} className="service-link">
                  {s.ref.name}
                </Link>
                {s.ref.peer ? <Tag>peer: {s.ref.peer}</Tag> : null}
                {s.ref.namespace ? <span className="muted"> · {s.ref.namespace}</span> : null}
              </td>
              <td>
                <HealthBadge status={s.health} />
                <span className="check-counts muted" title="Passing / warning / critical checks, including node checks">
                  {s.checks.passing}/{s.checks.warning}/{s.checks.critical}
                </span>
              </td>
              <td className="num">{s.instanceCount}</td>
              <td>
                <MeshCell s={s} />
              </td>
              <td className="tags">
                {s.tags.slice(0, 4).map((t) => (
                  <Tag key={t}>{t}</Tag>
                ))}
                {s.tags.length > 4 ? <span className="muted">+{s.tags.length - 4}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ServicesPage({ gatewaysOnly = false }: { gatewaysOnly?: boolean }) {
  const { dc, query: dcQuery } = useDatacenter();
  const services = useServices(dc);
  const dcLink = useDcLink();
  const [params, setParams] = useSearchParams();
  // The input owns its value; the URL mirrors it for sharing. Binding the
  // input directly to the URL drops keystrokes during fast typing.
  const [q, setQ] = useState(() => params.get('q') ?? '');
  const deferredQ = useDeferredValue(q);
  const health = (params.get('health') as HealthStatus | null) ?? null;

  const scoped = useMemo(
    () => (services.data?.services ?? []).filter((s) => GATEWAY_KINDS.has(s.kind) === gatewaysOnly),
    [services.data, gatewaysOnly]
  );
  const counts = useMemo(() => {
    const c: Record<HealthStatus, number> = { critical: 0, warning: 0, passing: 0, none: 0 };
    for (const s of scoped) c[s.health]++;
    return c;
  }, [scoped]);
  const visible = useMemo(
    () => sortServices(scoped.filter((s) => matchesSearch(s, deferredQ) && (!health || s.health === health))),
    [scoped, deferredQ, health]
  );

  const update = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const title = gatewaysOnly ? 'Gateways' : 'Services';
  const what = gatewaysOnly ? 'gateways' : 'services';

  return (
    <div className="page">
      <PageHeader
        title={title}
        subtitle={
          gatewaysOnly
            ? 'Mesh, terminating, ingress and API gateways registered in this datacenter.'
            : 'Service catalog. Sidecar proxies are folded into their services.'
        }
        actions={
          <FetchedAt
            iso={services.data?.meta.fetchedAt}
            source={services.data?.meta.source}
            onRefresh={() => services.refetch()}
            busy={services.isFetching}
          />
        }
      />
      {dcQuery.isError ? <ErrorState error={dcQuery.error} what="datacenters" /> : null}
      <FilteredByACLsNotice show={services.data?.meta.filteredByACLs} />

      <div className="toolbar" role="search">
        <input
          type="search"
          data-primary-search
          placeholder={`Filter ${what} by name or tag  ( / )`}
          aria-label={`Filter ${what} by name or tag`}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            update('q', e.target.value || null);
          }}
        />
        <div className="chip-group" role="group" aria-label="Filter by health">
          <button type="button" className="chip" aria-pressed={!health} onClick={() => update('health', null)}>
            All <span className="count">{scoped.length}</span>
          </button>
          {HEALTH_FILTERS.map((h) => (
            <button
              key={h}
              type="button"
              className={`chip chip-${h}`}
              aria-pressed={health === h}
              onClick={() => update('health', health === h ? null : h)}
            >
              {HEALTH_LABEL[h]} <span className="count">{counts[h]}</span>
            </button>
          ))}
        </div>
      </div>

      {services.isPending && dc ? <Loading label={`Loading ${what}…`} /> : null}
      {services.isError ? <ErrorState error={services.error} what={what} /> : null}
      {services.isSuccess && scoped.length === 0 ? (
        <EmptyState title={`No ${what} visible in ${dc}`}>
          {gatewaysOnly
            ? 'No gateways are registered, or your token cannot read them.'
            : 'Nothing is registered, or your ACL token cannot read any services.'}
        </EmptyState>
      ) : null}
      {services.isSuccess && scoped.length > 0 && visible.length === 0 ? (
        <EmptyState title="No matches">Try a different filter.</EmptyState>
      ) : null}
      {visible.length > 0 ? <ServiceTable services={visible} dcLink={dcLink} /> : null}
    </div>
  );
}
