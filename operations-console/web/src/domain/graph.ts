import {
  EVIDENCE_STRENGTH,
  type EvidenceClass,
  type EvidenceRecord,
  type Relationship,
  type TopologyGraph,
  type TopologyNode,
} from './types';

export interface GraphFilter {
  /** Evidence classes to show. */
  classes: ReadonlySet<EvidenceClass>;
  /**
   * Show relationships supported only by broad policy (default-allow ACL
   * policy, wildcard intentions). In a transparent-proxy mesh with default
   * allow, these connect every service to every other service, so they are
   * hidden by default and counted instead.
   */
  includeBroad: boolean;
}

export const DEFAULT_FILTER: GraphFilter = {
  classes: new Set<EvidenceClass>(['declared', 'discovered', 'inferred', 'observed', 'unknown']),
  includeBroad: false,
};

export function evidencePasses(e: EvidenceRecord, filter: GraphFilter): boolean {
  return filter.classes.has(e.class) && (filter.includeBroad || !e.broad);
}

/** Strongest evidence class supporting a relationship (by EVIDENCE_STRENGTH order). */
export function strongestClass(evidence: readonly EvidenceRecord[]): EvidenceClass {
  for (const cls of EVIDENCE_STRENGTH) {
    if (evidence.some((e) => e.class === cls)) return cls;
  }
  return 'unknown';
}

export interface FilteredGraph {
  /** Nodes with at least one visible relationship. */
  connected: TopologyNode[];
  /** Nodes with no visible relationship (shown separately to reduce noise). */
  isolated: TopologyNode[];
  /** Visible relationships, each with only the evidence that passed the filter. */
  edges: Relationship[];
  /** Relationships hidden by the filter. */
  hiddenEdges: number;
  /** Of the hidden relationships, those hidden only because they are broad-policy inferences. */
  hiddenBroadEdges: number;
}

export function filterGraph(graph: TopologyGraph, filter: GraphFilter): FilteredGraph {
  const edges: Relationship[] = [];
  let hiddenEdges = 0;
  let hiddenBroadEdges = 0;
  const touched = new Set<string>();

  for (const rel of graph.edges.values()) {
    const visible = rel.evidence.filter((e) => evidencePasses(e, filter));
    if (visible.length === 0) {
      hiddenEdges++;
      const withBroad = { ...filter, includeBroad: true };
      if (rel.evidence.some((e) => evidencePasses(e, withBroad))) hiddenBroadEdges++;
      continue;
    }
    edges.push({ ...rel, evidence: visible });
    touched.add(rel.from);
    touched.add(rel.to);
  }

  const connected: TopologyNode[] = [];
  const isolated: TopologyNode[] = [];
  for (const node of graph.nodes.values()) {
    (touched.has(node.id) ? connected : isolated).push(node);
  }
  const byName = (a: TopologyNode, b: TopologyNode) => a.id.localeCompare(b.id);
  connected.sort(byName);
  isolated.sort(byName);
  edges.sort((a, b) => a.id.localeCompare(b.id));
  return { connected, isolated, edges, hiddenEdges, hiddenBroadEdges };
}

/** A node plus its direct downstreams and upstreams. */
export function neighbourhood(edges: readonly Relationship[], id: string): Set<string> {
  const out = new Set<string>([id]);
  for (const e of edges) {
    if (e.from === id) out.add(e.to);
    if (e.to === id) out.add(e.from);
  }
  return out;
}

export function relationshipsOf(
  graph: TopologyGraph,
  id: string
): { upstreams: Relationship[]; downstreams: Relationship[] } {
  const upstreams: Relationship[] = [];
  const downstreams: Relationship[] = [];
  for (const e of graph.edges.values()) {
    if (e.from === id) upstreams.push(e);
    if (e.to === id) downstreams.push(e);
  }
  const byOther = (key: 'from' | 'to') => (a: Relationship, b: Relationship) =>
    a[key].localeCompare(b[key]);
  upstreams.sort(byOther('to'));
  downstreams.sort(byOther('from'));
  return { upstreams, downstreams };
}
