import { useMemo } from 'react';
import { Link } from 'react-router';
import { useDatacenter, useDcLink } from '../../app/useDatacenter';
import { EvidenceBadge, HealthBadge, kindLabel } from '../../components/Badges';
import { ErrorState, FetchedAt, FilteredByACLsNotice, Loading, Notice, PageHeader } from '../../components/States';
import { compareHealth, HEALTH_LABEL } from '../../domain/health';
import { strongestClass } from '../../domain/graph';
import type { EvidenceClass, HealthStatus, ServiceKind } from '../../domain/types';
import { GATEWAY_KINDS } from '../../providers/consul/mappers';
import { useCapabilities, useLeader, useMeshTopology, useServices } from '../../providers/consul/queries';

function HealthBar({ counts, total }: { counts: Record<HealthStatus, number>; total: number }) {
  const order: HealthStatus[] = ['critical', 'warning', 'none', 'passing'];
  return (
    <div className="health-bar" role="img" aria-label={order.map((h) => `${counts[h]} ${HEALTH_LABEL[h]}`).join(', ')}>
      {order.map((h) =>
        counts[h] ? <span key={h} className={`seg seg-${h}`} style={{ flexGrow: counts[h] / Math.max(1, total) }} /> : null
      )}
    </div>
  );
}

export function OverviewPage() {
  const { dc, datacenters, query: dcQuery } = useDatacenter();
  const services = useServices(dc);
  const leader = useLeader(dc);
  const caps = useCapabilities();
  const topology = useMeshTopology(dc);
  const dcLink = useDcLink();

  const stats = useMemo(() => {
    const list = services.data?.services ?? [];
    const apps = list.filter((s) => !GATEWAY_KINDS.has(s.kind));
    const counts: Record<HealthStatus, number> = { critical: 0, warning: 0, passing: 0, none: 0 };
    for (const s of list) counts[s.health]++;
    const gateways = new Map<ServiceKind, number>();
    for (const s of list) if (GATEWAY_KINDS.has(s.kind)) gateways.set(s.kind, (gateways.get(s.kind) ?? 0) + 1);
    const attention = list
      .filter((s) => s.health === 'critical' || s.health === 'warning')
      .sort((a, b) => compareHealth(a.health, b.health) || a.ref.name.localeCompare(b.ref.name));
    return {
      total: list.length,
      counts,
      apps: apps.length,
      meshApps: apps.filter((s) => s.meshEnabled).length,
      gateways,
      attention,
    };
  }, [services.data]);

  const relCounts = useMemo(() => {
    const c: Partial<Record<EvidenceClass, number>> = {};
    let broadOnly = 0;
    for (const r of topology.data?.edges.values() ?? []) {
      if (r.evidence.every((e) => e.broad)) {
        broadOnly++;
        continue;
      }
      const cls = strongestClass(r.evidence.filter((e) => !e.broad));
      c[cls] = (c[cls] ?? 0) + 1;
    }
    return { c, broadOnly };
  }, [topology.data]);

  const policy = dcQuery.data?.defaultACLPolicy;

  return (
    <div className="page">
      <PageHeader
        title="Overview"
        subtitle={<>Datacenter {dc ?? '…'} at a glance. Everything here links to the evidence behind it.</>}
        actions={
          <FetchedAt
            iso={services.data?.meta.fetchedAt}
            source={services.data?.meta.source}
            onRefresh={() => {
              void services.refetch();
              void leader.refetch();
              void topology.refetch();
            }}
            busy={services.isFetching || topology.isFetching}
          />
        }
      />
      {dcQuery.isError ? <ErrorState error={dcQuery.error} what="datacenters" /> : null}
      {services.isError ? <ErrorState error={services.error} what="services" /> : null}
      <FilteredByACLsNotice show={services.data?.meta.filteredByACLs} />
      {services.isPending && dc ? <Loading /> : null}

      {services.isSuccess ? (
        <div className="cards">
          <section className="card">
            <h2>Services</h2>
            <p className="big">{stats.total}</p>
            <HealthBar counts={stats.counts} total={stats.total} />
            <ul className="legend-list">
              {(['critical', 'warning', 'none', 'passing'] as const).map((h) => (
                <li key={h}>
                  <Link to={dcLink('/services', { health: h })}>
                    <HealthBadge status={h} /> {stats.counts[h]}
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>Mesh coverage</h2>
            <p className="big">
              {stats.meshApps}
              <span className="of">/ {stats.apps}</span>
            </p>
            <p className="muted small">
              Services with a sidecar proxy, transparent proxy or native Connect. Others are outside the mesh.
            </p>
          </section>

          <section className="card">
            <h2>Gateways</h2>
            <p className="big">{[...stats.gateways.values()].reduce((a, b) => a + b, 0)}</p>
            <ul className="legend-list">
              {[...stats.gateways].map(([k, n]) => (
                <li key={k}>
                  {kindLabel(k)}: {n}
                </li>
              ))}
            </ul>
            <Link to={dcLink('/gateways')} className="small">
              View gateways
            </Link>
          </section>

          <section className="card">
            <h2>Cluster</h2>
            <dl className="kv">
              <dt>Datacenters</dt>
              <dd>{datacenters.join(', ') || '—'}</dd>
              <dt>Leader</dt>
              <dd>
                {leader.isError ? (
                  <span className="warn-text">unknown</span>
                ) : leader.data ? (
                  leader.data.leader ? (
                    <span className="mono">{leader.data.leader}</span>
                  ) : (
                    <span className="crit-text">no leader</span>
                  )
                ) : (
                  '…'
                )}
              </dd>
              <dt>ACL default</dt>
              <dd title="X-Consul-Default-ACL-Policy">{policy ?? 'unknown'}</dd>
              <dt>Edition</dt>
              <dd>{caps.data ? (caps.data.namespaces ? 'Namespaces available (Enterprise)' : 'No namespaces (Community)') : '…'}</dd>
            </dl>
          </section>
        </div>
      ) : null}

      {policy === 'allow' ? (
        <Notice>
          The ACL default policy is <strong>allow</strong>. Transparent-proxy services can reach any service unless an
          intention denies it, so the topology hides those broad inferences by default.
        </Notice>
      ) : null}

      {services.isSuccess ? (
        <div className="two-col">
          <section className="card">
            <h2>Needs attention</h2>
            {stats.attention.length === 0 ? (
              <p className="muted">No services report warning or critical checks.</p>
            ) : (
              <ul className="attention">
                {stats.attention.map((s) => (
                  <li key={s.id}>
                    <HealthBadge status={s.health} />
                    <Link to={dcLink(`/services/${encodeURIComponent(s.ref.name)}`)}>{s.ref.name}</Link>
                    <span className="muted small">
                      {s.checks.critical} critical · {s.checks.warning} warning
                    </span>
                    <Link className="small" to={dcLink('/topology', { focus: s.ref.name })}>
                      dependencies
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card">
            <h2>Relationships</h2>
            {topology.isPending ? <Loading label="Inspecting mesh services…" /> : null}
            {topology.isError ? <ErrorState error={topology.error} what="relationships" /> : null}
            {topology.isSuccess ? (
              <>
                <ul className="legend-list">
                  {(['declared', 'discovered', 'inferred', 'unknown'] as const).map((c) =>
                    relCounts.c[c] ? (
                      <li key={c}>
                        <EvidenceBadge cls={c} /> {relCounts.c[c]}
                      </li>
                    ) : null
                  )}
                  {relCounts.broadOnly ? (
                    <li className="muted">+ {relCounts.broadOnly} broad-policy inferences</li>
                  ) : null}
                </ul>
                <p className="muted small">
                  Configured or permitted relationships, not observed traffic. {topology.data.inspected} services
                  inspected
                  {topology.data.issues.length ? `, ${topology.data.issues.length} with issues` : ''}.
                </p>
                <Link to={dcLink('/topology')} className="small">
                  Open topology
                </Link>
              </>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
