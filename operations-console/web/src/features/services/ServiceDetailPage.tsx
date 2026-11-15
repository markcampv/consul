import { Link, useParams } from 'react-router';
import { useDatacenter, useDcLink } from '../../app/useDatacenter';
import { HealthBadge, Tag, kindLabel } from '../../components/Badges';
import { EmptyState, ErrorState, FetchedAt, FilteredByACLsNotice, Loading, Notice, PageHeader } from '../../components/States';
import { relationshipsOf } from '../../domain/graph';
import type { TopologyGraph } from '../../domain/types';
import type { ServiceInstance } from '../../providers/consul/mappers';
import { useMeshTopology, useServiceInstances, useServices } from '../../providers/consul/queries';
import { RelationshipTable } from '../topology/RelationshipTable';
import { MeshCell } from './ServicesPage';

function InstancesTable({ instances }: { instances: ServiceInstance[] }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Instance</th>
            <th scope="col">Node</th>
            <th scope="col">Address</th>
            <th scope="col">Health</th>
            <th scope="col">Checks</th>
          </tr>
        </thead>
        <tbody>
          {instances.map((i) => (
            <tr key={`${i.node}/${i.id}`}>
              <td className="mono">{i.id}</td>
              <td>{i.node}</td>
              <td className="mono">
                {i.address}:{i.port}
              </td>
              <td>
                <HealthBadge status={i.health} />
              </td>
              <td>
                <details className="checks">
                  <summary>
                    {i.checks.length} check{i.checks.length === 1 ? '' : 's'}
                  </summary>
                  <ul>
                    {i.checks.map((c) => (
                      <li key={c.id}>
                        <HealthBadge status={c.status} compact /> <strong>{c.name}</strong>{' '}
                        <span className="muted">
                          ({c.scope} check{c.type ? `, ${c.type}` : ''})
                        </span>
                        {c.output ? <pre className="check-output">{c.output}</pre> : null}
                      </li>
                    ))}
                  </ul>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Relationships({ graph, serviceId }: { graph: TopologyGraph; serviceId: string }) {
  const { upstreams, downstreams } = relationshipsOf(graph, serviceId);
  const issue = graph.issues.find((i) => i.serviceId === serviceId);
  return (
    <>
      {issue ? <Notice tone="warn">Relationships may be incomplete: {issue.message}</Notice> : null}
      <div className="two-col">
        <section aria-labelledby="up-h">
          <h3 id="up-h">
            Upstreams <span className="count">{upstreams.length}</span>
          </h3>
          <p className="muted small">Services this one may call.</p>
          {upstreams.length ? (
            <RelationshipTable graph={graph} relationships={upstreams} side="to" />
          ) : (
            <EmptyState title="No known upstreams" />
          )}
        </section>
        <section aria-labelledby="down-h">
          <h3 id="down-h">
            Downstreams <span className="count">{downstreams.length}</span>
          </h3>
          <p className="muted small">Services that may call this one.</p>
          {downstreams.length ? (
            <RelationshipTable graph={graph} relationships={downstreams} side="from" />
          ) : (
            <EmptyState title="No known downstreams" />
          )}
        </section>
      </div>
    </>
  );
}

export function ServiceDetailPage() {
  const { name = '' } = useParams();
  const { dc } = useDatacenter();
  const dcLink = useDcLink();
  const services = useServices(dc);
  const instances = useServiceInstances(dc, name);
  const topology = useMeshTopology(dc);

  const summary = services.data?.services.find((s) => s.ref.name === name && !s.ref.peer);
  const node = summary ? topology.data?.nodes.get(summary.id) : undefined;

  return (
    <div className="page">
      <nav aria-label="Breadcrumb" className="breadcrumbs">
        <Link to={dcLink('/services')}>Services</Link> <span aria-hidden="true">/</span> <span>{name}</span>
      </nav>
      <PageHeader
        title={
          <>
            {name} {summary ? <HealthBadge status={summary.health} /> : null}
          </>
        }
        subtitle={
          summary ? (
            <>
              {kindLabel(summary.kind, summary.rawKind)} · {summary.instanceCount} instance
              {summary.instanceCount === 1 ? '' : 's'} · {dc} · <MeshCell s={summary} />
            </>
          ) : null
        }
        actions={
          <>
            <FetchedAt
              iso={instances.data?.meta.fetchedAt}
              source={instances.data?.meta.source}
              onRefresh={() => {
                void instances.refetch();
                void topology.refetch();
              }}
              busy={instances.isFetching || topology.isFetching}
            />
            <Link className="btn" to={dcLink('/topology', { focus: name })}>
              Show in topology
            </Link>
          </>
        }
      />
      {services.isSuccess && !summary ? (
        <Notice tone="warn">
          {name} is not in the {dc} catalog listing. It may be a virtual service (routing configuration only), live in
          another datacenter, or be hidden by ACLs.
        </Notice>
      ) : null}
      {summary && summary.tags.length ? (
        <p className="tags">
          {summary.tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </p>
      ) : null}

      <section aria-labelledby="inst-h" className="section">
        <h2 id="inst-h">Instances</h2>
        <FilteredByACLsNotice show={instances.data?.meta.filteredByACLs} />
        {instances.isPending ? <Loading label="Loading instances…" /> : null}
        {instances.isError ? <ErrorState error={instances.error} what="instances" /> : null}
        {instances.isSuccess && instances.data.instances.length === 0 ? (
          <EmptyState title="No instances">
            {node?.external === 'virtual'
              ? 'This is a virtual service: it exists only as routing configuration.'
              : 'No instances are registered or visible to your token.'}
          </EmptyState>
        ) : null}
        {instances.isSuccess && instances.data.instances.length > 0 ? (
          <InstancesTable instances={instances.data.instances} />
        ) : null}
      </section>

      <section aria-labelledby="rel-h" className="section">
        <h2 id="rel-h">Relationships</h2>
        <p className="muted">
          From Consul’s service topology: configuration and intentions, <strong>not observed traffic</strong>.
        </p>
        {topology.isPending ? <Loading label="Building relationships…" /> : null}
        {topology.isError ? <ErrorState error={topology.error} what="relationships" /> : null}
        {topology.isSuccess && summary ? <Relationships graph={topology.data} serviceId={summary.id} /> : null}
      </section>
    </div>
  );
}
