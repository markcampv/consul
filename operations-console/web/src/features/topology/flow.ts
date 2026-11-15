/**
 * Convert a filtered topology into React Flow nodes and edges. Pure and
 * testable; the page component only wires state and events.
 */
import { MarkerType, type Edge, type Node } from '@xyflow/react';
import { neighbourhood, strongestClass, type FilteredGraph } from '../../domain/graph';
import { DEFAULT_LAYOUT, gridLayout, routedLayeredLayout, type Point } from '../../domain/layout';
import type { EvidenceClass, Relationship, TopologyNode } from '../../domain/types';

export type ServiceNodeData = { node: TopologyNode; dimmed: boolean };
export type LabelNodeData = { label: string };
export type ServiceFlowNode = Node<ServiceNodeData, 'service'>;
export type LabelFlowNode = Node<LabelNodeData, 'label'>;
export type FlowNode = ServiceFlowNode | LabelFlowNode;
export type FlowEdge = Edge<{ rel: Relationship; cls: EvidenceClass; waypoints: Point[] }, 'routed'>;

export const ISOLATED_LABEL_ID = '__isolated_label__';

const EDGE_COLORS = {
  light: { declared: '#334155', discovered: '#2563eb', inferred: '#7c3aed', observed: '#047857', unknown: '#94a3b8', denied: '#c81e1e' },
  dark: { declared: '#cbd5e1', discovered: '#60a5fa', inferred: '#c4b5fd', observed: '#34d399', unknown: '#64748b', denied: '#f87171' },
} as const;

export interface FlowOptions {
  showIsolated: boolean;
  selectedNode?: string;
  selectedEdge?: string;
  theme: 'light' | 'dark';
}

export function toFlow(g: FilteredGraph, o: FlowOptions): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const { positions, waypoints } = routedLayeredLayout(
    g.connected.map((n) => n.id),
    g.edges
  );
  const focus = o.selectedNode ? neighbourhood(g.edges, o.selectedNode) : null;
  const focusEdge = o.selectedEdge ? g.edges.find((e) => e.id === o.selectedEdge) : undefined;
  const isDimmed = (id: string) =>
    focus ? !focus.has(id) : focusEdge ? id !== focusEdge.from && id !== focusEdge.to : false;

  const nodes: FlowNode[] = g.connected.map((n) => ({
    id: n.id,
    type: 'service',
    position: positions.get(n.id)!,
    data: { node: n, dimmed: isDimmed(n.id) },
    selected: n.id === o.selectedNode,
    ariaLabel: `${n.service.ref.name}, ${n.service.health}`,
  }));

  if (o.showIsolated && g.isolated.length) {
    const maxY = Math.max(-DEFAULT_LAYOUT.nodeHeight, ...[...positions.values()].map((p) => p.y));
    const ranks = new Set([...positions.values()].map((p) => p.x)).size;
    const originY = maxY + DEFAULT_LAYOUT.nodeHeight + 110;
    nodes.push({
      id: ISOLATED_LABEL_ID,
      type: 'label',
      position: { x: 0, y: originY - 44 },
      data: { label: `No visible relationships (${g.isolated.length})` },
      selectable: false,
      focusable: false,
    });
    const grid = gridLayout(
      g.isolated.map((n) => n.id),
      { x: 0, y: originY },
      Math.max(3, ranks)
    );
    for (const n of g.isolated) {
      nodes.push({
        id: n.id,
        type: 'service',
        position: grid.get(n.id)!,
        data: { node: n, dimmed: Boolean(focus || focusEdge) },
        selected: n.id === o.selectedNode,
        ariaLabel: `${n.service.ref.name}, ${n.service.health}, no visible relationships`,
      });
    }
  }

  const palette = EDGE_COLORS[o.theme];
  const edges: FlowEdge[] = g.edges.map((rel) => {
    const cls = strongestClass(rel.evidence);
    const denied = rel.intention?.verdict === 'denied';
    const dimmed = focus ? !(rel.from === o.selectedNode || rel.to === o.selectedNode) : focusEdge ? rel.id !== focusEdge.id : false;
    const color = denied ? palette.denied : palette[cls];
    return {
      id: rel.id,
      source: rel.from,
      target: rel.to,
      type: 'routed',
      className: ['edge', `edge-${cls}`, denied ? 'edge-denied' : '', dimmed ? 'dimmed' : ''].filter(Boolean).join(' '),
      selected: rel.id === o.selectedEdge,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
      style: { stroke: color },
      ...(denied ? { label: 'denied' } : rel.intention?.verdict === 'conditional' ? { label: 'L7' } : {}),
      data: { rel, cls, waypoints: waypoints.get(rel.id) ?? [] },
      ariaLabel: `${rel.from.split('/').pop()} to ${rel.to.split('/').pop()}, ${cls}${denied ? ', denied by intention' : ''}`,
    };
  });

  return { nodes, edges };
}
