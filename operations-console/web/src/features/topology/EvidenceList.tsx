import { EvidenceBadge, EVIDENCE_LABEL, IntentionBadge } from '../../components/Badges';
import type { Relationship, TopologyGraph } from '../../domain/types';

const nameOf = (graph: TopologyGraph, id: string) => graph.nodes.get(id)?.service.ref.name ?? id;

/** Every piece of evidence for a relationship: what, from where, when, and how much to trust it. */
export function EvidenceList({ graph, rel }: { graph: TopologyGraph; rel: Relationship }) {
  return (
    <div className="evidence-list">
      <dl className="kv">
        <dt>Intention</dt>
        <dd>
          <IntentionBadge intention={rel.intention} />{' '}
          {rel.intention ? (
            <span className="muted small">
              {rel.intention.verdict === 'conditional'
                ? 'L7 permissions: decided per request'
                : rel.intention.match === 'exact'
                  ? 'decided by an exact intention'
                  : `decided by a wildcard intention or the default policy (${rel.intention.defaultPolicy}); Consul does not say which`}
              {rel.intention.externalSource ? ` · managed by ${rel.intention.externalSource}` : ''}
            </span>
          ) : null}
        </dd>
        {rel.intentionConflict ? (
          <>
            <dt>Conflict</dt>
            <dd className="warn-text">The two services reported different intention decisions.</dd>
          </>
        ) : null}
        <dt>Traffic</dt>
        <dd className="muted small">Not observed. Consul configuration APIs do not report live traffic.</dd>
      </dl>
      <ol className="evidence-items">
        {rel.evidence.map((e, i) => (
          <li key={i}>
            <div className="evidence-head">
              <EvidenceBadge cls={e.class} />
              <code>{e.origin}</code>
              <span className="muted small">reported by {nameOf(graph, e.reportedBy)}</span>
            </div>
            <p>{e.description}</p>
            {e.reclassifiedFrom ? (
              <p className="small">
                Consul’s label suggests <strong>{EVIDENCE_LABEL[e.reclassifiedFrom]}</strong>; the console shows{' '}
                <strong>{EVIDENCE_LABEL[e.class]}</strong> for the reason below.
              </p>
            ) : null}
            {e.caveat ? <p className="caveat">⚠ {e.caveat}</p> : null}
            <p className="muted small">
              Source <code>{e.source}</code> · fetched {new Date(e.fetchedAt).toLocaleString()}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}
