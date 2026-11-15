import { assignRanks, countCrossings, gridLayout, layeredLayout, orderRanks, routedLayeredLayout } from './layout';

const e = (from: string, to: string) => ({ from, to });

describe('assignRanks', () => {
  it('ranks downstreams before upstreams along the longest path', () => {
    const ranks = assignRanks(['a', 'b', 'c', 'd'], [e('a', 'b'), e('b', 'c'), e('a', 'c'), e('d', 'c')]);
    expect(Object.fromEntries(ranks)).toEqual({ a: 0, b: 1, c: 2, d: 0 });
  });

  it('tolerates cycles without looping or dropping nodes', () => {
    const ranks = assignRanks(['a', 'b', 'c'], [e('a', 'b'), e('b', 'c'), e('c', 'a')]);
    expect([...ranks.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(ranks.get('a')).toBe(0);
    expect(ranks.get('c')).toBe(2);
  });

  it('ignores self-loops and edges to unknown nodes', () => {
    const ranks = assignRanks(['a'], [e('a', 'a'), e('a', 'ghost')]);
    expect(Object.fromEntries(ranks)).toEqual({ a: 0 });
  });
});

describe('orderRanks', () => {
  it('reduces crossings with barycentre ordering', () => {
    // a->y, b->x: alphabetical order in rank 1 would cross.
    const edges = [e('a', 'y'), e('b', 'x')];
    const ranks = assignRanks(['a', 'b', 'x', 'y'], edges);
    const unordered = orderRanks(ranks, edges, 0);
    const ordered = orderRanks(ranks, edges, 2);
    expect(countCrossings(unordered, edges)).toBe(1);
    expect(countCrossings(ordered, edges)).toBe(0);
  });
});

describe('layeredLayout', () => {
  it('is deterministic regardless of input order', () => {
    const edges = [e('frontend', 'api'), e('api', 'payments'), e('api', 'inventory')];
    const a = layeredLayout(['payments', 'api', 'frontend', 'inventory'], edges);
    const b = layeredLayout(['inventory', 'frontend', 'payments', 'api'], [...edges].reverse());
    expect([...a].sort()).toEqual([...b].sort());
  });

  it('places callers left of callees and separates nodes in a rank', () => {
    const pos = layeredLayout(['f', 'a', 'p', 'i'], [e('f', 'a'), e('a', 'p'), e('a', 'i')], {
      nodeWidth: 100,
      rankGap: 50,
      nodeHeight: 40,
      nodeGap: 10,
    });
    expect(pos.get('f')!.x).toBeLessThan(pos.get('a')!.x);
    expect(pos.get('a')!.x).toBeLessThan(pos.get('p')!.x);
    expect(pos.get('p')!.x).toBe(pos.get('i')!.x);
    expect(Math.abs(pos.get('p')!.y - pos.get('i')!.y)).toBe(50);
  });
});

describe('routedLayeredLayout', () => {
  const o = { nodeWidth: 100, nodeHeight: 40, rankGap: 50, nodeGap: 10 };

  it('routes an edge that skips a rank through an empty slot, not behind a node', () => {
    // frontend -> api -> payments, plus frontend -> payments (skips api's rank).
    const edges = [e('frontend', 'api'), e('api', 'payments'), e('frontend', 'payments')];
    const { positions, waypoints } = routedLayeredLayout(['frontend', 'api', 'payments'], edges, o);
    const pts = waypoints.get('frontend->payments')!;
    expect(pts).toHaveLength(2);
    const api = positions.get('api')!;
    expect(pts[0]!.x).toBe(api.x);
    expect(pts[1]!.x).toBe(api.x + o.nodeWidth);
    // The reserved slot must not overlap the api node vertically.
    const midY = pts[0]!.y;
    expect(midY < api.y || midY > api.y + o.nodeHeight).toBe(true);
    expect(waypoints.has('frontend->api')).toBe(false);
  });

  it('does not expose dummy nodes as positions', () => {
    const { positions } = routedLayeredLayout(['a', 'b', 'c', 'd'], [e('a', 'b'), e('b', 'c'), e('c', 'd'), e('a', 'd')], o);
    expect([...positions.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('gridLayout', () => {
  it('wraps sorted ids into columns', () => {
    const pos = gridLayout(['c', 'a', 'b'], { x: 0, y: 100 }, 2, { nodeWidth: 10, nodeHeight: 10, nodeGap: 0 });
    expect(pos.get('a')).toEqual({ x: 0, y: 100 });
    expect(pos.get('b')).toEqual({ x: 10, y: 100 });
    expect(pos.get('c')).toEqual({ x: 0, y: 110 });
  });
});
