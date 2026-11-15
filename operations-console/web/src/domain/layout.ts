/**
 * Deterministic layered ("Sugiyama-lite") layout for dependency graphs.
 *
 * Downstreams (callers) are placed left of their upstreams (callees). This is
 * intentionally small and dependency-free. Larger meshes, or orthogonal edge
 * routing, can swap in ELK.js behind the same `layeredLayout` signature
 * (see docs/operations-console/DECISIONS.md, ADR-004).
 */

export interface LayoutEdge {
  from: string;
  to: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  /** Horizontal gap between ranks. */
  rankGap: number;
  /** Vertical gap between nodes in the same rank. */
  nodeGap: number;
  /** Barycentre ordering passes. */
  sweeps: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  nodeWidth: 220,
  nodeHeight: 64,
  rankGap: 120,
  nodeGap: 28,
  sweeps: 4,
};

/**
 * Assign each node a rank = length of the longest path reaching it, ignoring
 * edges that close a cycle. Cycles are legitimate in service meshes
 * (A -> B -> A), so they must not break the layout.
 */
export function assignRanks(nodeIds: readonly string[], edges: readonly LayoutEdge[]): Map<string, number> {
  const ids = [...new Set(nodeIds)].sort();
  const known = new Set(ids);
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  for (const e of edges) {
    if (known.has(e.from) && known.has(e.to) && e.from !== e.to) out.get(e.from)!.push(e.to);
  }
  for (const list of out.values()) list.sort();

  // Iterative DFS to find back edges (deterministic: sorted roots and children).
  const state = new Map<string, 0 | 1 | 2>(); // 0 new, 1 on stack, 2 done
  const back = new Set<string>();
  for (const root of ids) {
    if (state.get(root)) continue;
    const stack: Array<{ id: string; i: number }> = [{ id: root, i: 0 }];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const children = out.get(top.id)!;
      if (top.i < children.length) {
        const next = children[top.i++]!;
        const s = state.get(next) ?? 0;
        if (s === 1) back.add(`${top.id}\u0000${next}`);
        else if (s === 0) {
          state.set(next, 1);
          stack.push({ id: next, i: 0 });
        }
      } else {
        state.set(top.id, 2);
        stack.pop();
      }
    }
  }

  // Longest path over the DAG (Kahn's algorithm).
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const dag = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [from, tos] of out) {
    for (const to of tos) {
      if (back.has(`${from}\u0000${to}`)) continue;
      dag.get(from)!.push(to);
      indeg.set(to, indeg.get(to)! + 1);
    }
  }
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const to of dag.get(id)!) {
      rank.set(to, Math.max(rank.get(to)!, rank.get(id)! + 1));
      indeg.set(to, indeg.get(to)! - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  return rank;
}

/** Order nodes within each rank to reduce edge crossings (barycentre heuristic). */
export function orderRanks(
  ranks: Map<string, number>,
  edges: readonly LayoutEdge[],
  sweeps: number
): string[][] {
  const maxRank = Math.max(-1, ...ranks.values());
  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const [id, r] of [...ranks].sort(([a], [b]) => a.localeCompare(b))) layers[r]!.push(id);

  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const e of edges) {
    if (!ranks.has(e.from) || !ranks.has(e.to) || e.from === e.to) continue;
    (preds.get(e.to) ?? preds.set(e.to, []).get(e.to)!).push(e.from);
    (succs.get(e.from) ?? succs.set(e.from, []).get(e.from)!).push(e.to);
  }

  const position = new Map<string, number>();
  const index = () => layers.forEach((l) => l.forEach((id, i) => position.set(id, i)));
  index();

  const reorder = (layer: string[], neighbours: Map<string, string[]>) => {
    const score = new Map<string, number>();
    layer.forEach((id, i) => {
      const ns = (neighbours.get(id) ?? []).filter((n) => position.has(n));
      score.set(id, ns.length ? ns.reduce((s, n) => s + position.get(n)!, 0) / ns.length : i);
    });
    // Array.prototype.sort is stable, so ties keep the previous order.
    layer.sort((a, b) => score.get(a)! - score.get(b)!);
  };

  for (let s = 0; s < sweeps; s++) {
    for (let r = 1; r < layers.length; r++) {
      reorder(layers[r]!, preds);
      index();
    }
    for (let r = layers.length - 2; r >= 0; r--) {
      reorder(layers[r]!, succs);
      index();
    }
  }
  return layers;
}

export const edgeKey = (e: LayoutEdge) => `${e.from}->${e.to}`;

export interface RoutedLayout {
  /** Top-left corner of each real node. */
  positions: Map<string, Point>;
  /**
   * For edges spanning more than one rank: points the edge must pass
   * through, keyed by `from->to`. Each intermediate rank reserves an empty
   * slot (a "dummy node") so the edge never runs behind an unrelated node.
   */
  waypoints: Map<string, Point[]>;
}

const DUMMY = '\u0000dummy:';

export function routedLayeredLayout(
  nodeIds: readonly string[],
  edges: readonly LayoutEdge[],
  options: Partial<LayoutOptions> = {}
): RoutedLayout {
  const o = { ...DEFAULT_LAYOUT, ...options };
  const ranks = assignRanks(nodeIds, edges);

  // Split long forward edges into chains through dummy nodes.
  const augmented: LayoutEdge[] = [];
  const chains = new Map<string, string[]>();
  for (const e of edges) {
    const rf = ranks.get(e.from);
    const rt = ranks.get(e.to);
    if (rf === undefined || rt === undefined || e.from === e.to) continue;
    if (rt - rf <= 1) {
      augmented.push(e);
      continue;
    }
    const key = edgeKey(e);
    if (chains.has(key)) continue;
    const dummies: string[] = [];
    let prev = e.from;
    for (let r = rf + 1; r < rt; r++) {
      const d = `${DUMMY}${key}#${r}`;
      ranks.set(d, r);
      dummies.push(d);
      augmented.push({ from: prev, to: d });
      prev = d;
    }
    augmented.push({ from: prev, to: e.to });
    chains.set(key, dummies);
  }

  const layers = orderRanks(ranks, augmented, o.sweeps);
  const tallest = Math.max(0, ...layers.map((l) => l.length));
  const step = o.nodeHeight + o.nodeGap;
  const all = new Map<string, Point>();
  layers.forEach((layer, r) => {
    const offset = ((tallest - layer.length) * step) / 2;
    layer.forEach((id, i) => {
      all.set(id, { x: r * (o.nodeWidth + o.rankGap), y: offset + i * step });
    });
  });

  const positions = new Map<string, Point>();
  for (const [id, p] of all) if (!id.startsWith(DUMMY)) positions.set(id, p);
  const waypoints = new Map<string, Point[]>();
  for (const [key, dummies] of chains) {
    const pts: Point[] = [];
    for (const d of dummies) {
      const p = all.get(d)!;
      const y = p.y + o.nodeHeight / 2;
      pts.push({ x: p.x, y }, { x: p.x + o.nodeWidth, y });
    }
    waypoints.set(key, pts);
  }
  return { positions, waypoints };
}

export function layeredLayout(
  nodeIds: readonly string[],
  edges: readonly LayoutEdge[],
  options: Partial<LayoutOptions> = {}
): Map<string, Point> {
  return routedLayeredLayout(nodeIds, edges, options).positions;
}

/** Simple grid for nodes without relationships, placed below the graph. */
export function gridLayout(
  nodeIds: readonly string[],
  origin: Point,
  columns: number,
  options: Partial<LayoutOptions> = {}
): Map<string, Point> {
  const o = { ...DEFAULT_LAYOUT, ...options };
  const cols = Math.max(1, columns);
  const positions = new Map<string, Point>();
  [...nodeIds].sort().forEach((id, i) => {
    positions.set(id, {
      x: origin.x + (i % cols) * (o.nodeWidth + o.nodeGap),
      y: origin.y + Math.floor(i / cols) * (o.nodeHeight + o.nodeGap),
    });
  });
  return positions;
}

/** Count edge crossings between adjacent ranks; used by tests to verify ordering quality. */
export function countCrossings(layers: string[][], edges: readonly LayoutEdge[]): number {
  const pos = new Map<string, [number, number]>();
  layers.forEach((l, r) => l.forEach((id, i) => pos.set(id, [r, i])));
  const segs = edges
    .map((e) => [pos.get(e.from), pos.get(e.to)] as const)
    .filter(([a, b]) => a && b && b[0] === a[0] + 1) as Array<readonly [[number, number], [number, number]]>;
  let n = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [a1, b1] = segs[i]!;
      const [a2, b2] = segs[j]!;
      if (a1[0] !== a2[0]) continue;
      if ((a1[1] - a2[1]) * (b1[1] - b2[1]) < 0) n++;
    }
  }
  return n;
}
