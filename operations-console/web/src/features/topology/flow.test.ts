import { DEFAULT_FILTER, filterGraph } from '../../domain/graph';
import { ConsulClient } from '../../providers/consul/client';
import { fetchMeshTopology, fetchServices } from '../../providers/consul/consul';
import { fixtureFetch } from '../../providers/consul/fixtures';
import { serviceId } from '../../providers/consul/mappers';
import { ISOLATED_LABEL_ID, toFlow } from './flow';

const id = (name: string) => serviceId({ name, datacenter: 'dc1' });

async function filtered() {
  const c = new ConsulClient({ fetch: fixtureFetch() });
  const cat = await fetchServices(c, 'dc1');
  return filterGraph(await fetchMeshTopology(c, cat, 'dc1'), DEFAULT_FILTER);
}

describe('toFlow', () => {
  it('styles edges by strongest evidence and labels denied intentions', async () => {
    const { edges } = toFlow(await filtered(), { showIsolated: false, theme: 'light' });
    const denied = edges.find((e) => e.id === `${id('api')}->${id('inventory')}`)!;
    expect(denied.label).toBe('denied');
    expect(denied.className).toContain('edge-denied');
    expect(edges.find((e) => e.id === `${id('frontend')}->${id('checkout')}`)!.className).toContain('edge-discovered');
    expect(edges.find((e) => e.id === `${id('audit')}->${id('ledger')}`)!.className).toContain('edge-inferred');
  });

  it('places isolated services in a labelled group only when requested', async () => {
    const g = await filtered();
    expect(toFlow(g, { showIsolated: false, theme: 'dark' }).nodes.some((n) => n.id === ISOLATED_LABEL_ID)).toBe(false);
    const withIsolated = toFlow(g, { showIsolated: true, theme: 'dark' });
    expect(withIsolated.nodes.some((n) => n.id === ISOLATED_LABEL_ID)).toBe(true);
    expect(withIsolated.nodes.some((n) => n.id === id('mesh-gateway'))).toBe(true);
  });

  it('dims everything outside the selected service neighbourhood', async () => {
    const { nodes, edges } = toFlow(await filtered(), {
      showIsolated: false,
      theme: 'light',
      selectedNode: id('api'),
    });
    const dim = (name: string) => (nodes.find((n) => n.id === id(name))!.data as { dimmed: boolean }).dimmed;
    expect(dim('api')).toBe(false);
    expect(dim('frontend')).toBe(false);
    expect(dim('payments')).toBe(false);
    expect(dim('ledger')).toBe(true);
    expect(edges.find((e) => e.id === `${id('payments')}->${id('ledger')}`)!.className).toContain('dimmed');
  });

  it('gives every service node a position and an accessible label', async () => {
    const { nodes } = toFlow(await filtered(), { showIsolated: true, theme: 'light' });
    for (const n of nodes) {
      expect(Number.isFinite(n.position.x) && Number.isFinite(n.position.y)).toBe(true);
      if (n.type === 'service') expect(n.ariaLabel).toMatch(/,/);
    }
  });
});
