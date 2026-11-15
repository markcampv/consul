import { Link } from 'react-router';
import { useDcLink } from '../../app/useDatacenter';
import { EvidenceBadge, HealthBadge, IntentionBadge, Tag } from '../../components/Badges';
import { EVIDENCE_STRENGTH, type Relationship, type TopologyGraph } from '../../domain/types';
import { EvidenceList } from './EvidenceList';

const EXTERNAL_LABEL = { remote: 'other DC', peer: 'peer', virtual: 'virtual' } as const;

export function RelationshipTable({
  graph,
  relationships,
  side,
}: {
  graph: TopologyGraph;
  relationships: Relationship[];
  /** Which end of each relationship to list. */
  side: 'from' | 'to';
}) {
  const dcLink = useDcLink();
  return (
    <ul className="rel-list">
      {relationships.map((r) => {
        const other = graph.nodes.get(r[side]);
        const name = other?.service.ref.name ?? r[side];
        const classes = EVIDENCE_STRENGTH.filter((c) => r.evidence.some((e) => e.class === c));
        const hasCaveat = r.evidence.some((e) => e.caveat);
        return (
          <li key={r.id} className="rel-item">
            <div className="rel-row">
              {other ? <HealthBadge status={other.service.health} compact /> : null}
              <Link to={dcLink(`/services/${encodeURIComponent(name)}`)}>{name}</Link>
              {other?.external ? <Tag>{EXTERNAL_LABEL[other.external]}</Tag> : null}
              <span className="spacer" />
              {classes.map((c) => (
                <EvidenceBadge key={c} cls={c} />
              ))}
              <IntentionBadge intention={r.intention} />
            </div>
            <details>
              <summary>
                Evidence ({r.evidence.length}){hasCaveat ? ' · ⚠ read caveat' : ''}
              </summary>
              <EvidenceList graph={graph} rel={r} />
            </details>
          </li>
        );
      })}
    </ul>
  );
}
