import { DEFAULT_FILTER, filterGraph, relationshipsOf } from '../../domain/graph';
import { ConsulClient } from './client';
import { fetchMeshTopology, fetchServiceInstances, fetchServices, detectCapabilities } from './consul';
import { fixtureFetch } from './fixtures';
import { evidenceFor, mapIntention, mapKind, serviceId, topologyTargets } from './mappers';

const client = new ConsulClient({ fetch: fixtureFetch(), now: () => new Date('2026-11-14T00:00:00Z') });
const id = (name: string) => serviceId({ name, datacenter: 'dc1' });

async function loadGraph() {
  const catalog = await fetchServices(client, 'dc1');
  const graph = await fetchMeshTopology(client, catalog, 'dc1', undefined, () => new Date('2026-11-14T00:00:00Z'));
  return { catalog, graph };
}

describe('serviceId / mapKind', () => {
  it('builds stable ids that distinguish peers and enterprise scopes', () => {
    expect(serviceId({ name: 'api', datacenter: 'dc1' })).toBe('dc1/-/-/api');
    expect(serviceId({ name: 'api', datacenter: 'dc1', peer: 'east' })).toBe('peer:east/-/-/api');
    expect(serviceId({ name: 'api', datacenter: 'dc1', partition: 'p', namespace: 'n' })).toBe('dc1/p/n/api');
  });
  it('maps unknown kinds to unknown instead of guessing', () => {
    expect(mapKind(undefined)).toBe('service');
    expect(mapKind('mesh-gateway')).toBe('mesh-gateway');
    expect(mapKind('future-gateway')).toBe('unknown');
  });
});

describe('evidenceFor', () => {
  const meta = { source: 'GET /v1/x', fetchedAt: 't' };
  it.each([
    ['proxy-registration', 'declared', false],
    ['routing-config', 'discovered', false],
    ['specific-intention', 'inferred', false],
    ['wildcard-intention', 'inferred', true],
    ['default-allow', 'inferred', true],
    ['something-new', 'unknown', false],
  ])('%s -> %s (broad=%s)', (source, cls, broad) => {
    const ev = evidenceFor(source, 'a', meta);
    expect(ev.class).toBe(cls);
    expect(ev.broad).toBe(broad);
  });
  it('never produces observed evidence from configuration', () => {
    for (const s of ['proxy-registration', 'routing-config', 'default-allow', '']) {
      expect(evidenceFor(s, 'a', meta).class).not.toBe('observed');
    }
  });
});

describe('mapIntention', () => {
  const base = { Allowed: true, HasPermissions: false, ExternalSource: '', HasExact: false, DefaultAllow: true };
  it('does not claim the default policy decided a non-exact match', () => {
    expect(mapIntention(base)).toEqual({ verdict: 'allowed', match: 'wildcard-or-default', defaultPolicy: 'allow' });
  });
  it('reports L7 permissions as conditional regardless of Allowed', () => {
    expect(mapIntention({ ...base, Allowed: false, HasPermissions: true })?.verdict).toBe('conditional');
  });
  it('maps exact denies', () => {
    expect(mapIntention({ ...base, Allowed: false, HasExact: true, DefaultAllow: false })).toEqual({
      verdict: 'denied',
      match: 'exact',
      defaultPolicy: 'deny',
    });
  });
});

describe('recorded dev mesh', () => {
  it('lists services without sidecar proxies and derives health', async () => {
    const { catalog } = await loadGraph();
    const names = catalog.services.map((s) => s.ref.name);
    expect(names).not.toContain('api-sidecar-proxy');
    expect(names).toEqual(expect.arrayContaining(['api', 'payments', 'legacy-billing', 'mesh-gateway']));
    const byName = Object.fromEntries(catalog.services.map((s) => [s.ref.name, s]));
    expect(byName.payments!.health).toBe('critical');
    expect(byName.inventory!.health).toBe('warning');
    expect(byName.api!.meshEnabled).toBe(true);
    expect(byName['legacy-billing']!.meshEnabled).toBe(false);
    expect(byName['legacy-billing']!.behindGateway).toBe(true);
    expect(byName['legacy-gateway']!.gatewayServiceCount).toBe(1);
  });

  it('queries topology only for mesh-enabled services and supported gateway kinds', async () => {
    const { catalog } = await loadGraph();
    const targets = topologyTargets(catalog.services).map((s) => s.ref.name).sort();
    expect(targets).toEqual(['api', 'audit', 'frontend', 'inventory', 'ledger', 'payments']);
  });

  it('merges both perspectives of declared upstreams into one relationship', async () => {
    const { graph } = await loadGraph();
    const rel = graph.edges.get(`${id('frontend')}->${id('api')}`)!;
    expect(rel).toBeDefined();
    expect(rel.evidence.map((e) => [e.class, e.origin, e.reportedBy]).sort()).toEqual([
      ['declared', 'proxy-registration', id('api')],
      ['declared', 'proxy-registration', id('frontend')],
    ]);
    expect(rel.evidence[0]!.source).toMatch(/^GET \/v1\/internal\/ui\/service-topology\//);
    expect(rel.evidence[0]!.fetchedAt).toBe('2026-11-14T00:00:00.000Z');
  });

  it('represents a routing-only upstream as a virtual node with discovered evidence', async () => {
    const { graph } = await loadGraph();
    const checkout = graph.nodes.get(id('checkout'))!;
    expect(checkout.external).toBe('virtual');
    const rel = graph.edges.get(`${id('frontend')}->${id('checkout')}`)!;
    expect(rel.evidence.map((e) => e.class)).toEqual(['discovered']);
  });

  it('reclassifies a relationship only the upstream reports as discovered, with a caveat', async () => {
    // frontend declares `checkout`, which a resolver redirects to payments.
    // Consul lists frontend as a downstream of payments, labelled proxy-registration.
    const { graph } = await loadGraph();
    const rel = graph.edges.get(`${id('frontend')}->${id('payments')}`)!;
    expect(rel.evidence).toHaveLength(1);
    expect(rel.evidence[0]).toMatchObject({
      class: 'discovered',
      reclassifiedFrom: 'declared',
      origin: 'proxy-registration',
      reportedBy: id('payments'),
    });
    expect(rel.evidence[0]!.caveat).toMatch(/frontend does not list payments/);
  });

  it('flags routing-config labels reported by a transparent proxy', async () => {
    const { graph } = await loadGraph();
    const rel = graph.edges.get(`${id('audit')}->${id('checkout')}`)!;
    expect(rel.evidence[0]!.class).toBe('discovered');
    expect(rel.evidence[0]!.caveat).toMatch(/transparent proxy/);
    // A declared upstream of a non-tproxy service carries no caveat.
    expect(graph.edges.get(`${id('frontend')}->${id('checkout')}`)!.evidence[0]!.caveat).toBeUndefined();
  });

  it('keeps the deny intention on a declared upstream', async () => {
    const { graph } = await loadGraph();
    const rel = graph.edges.get(`${id('api')}->${id('inventory')}`)!;
    expect(rel.intention).toMatchObject({ verdict: 'denied', match: 'exact' });
    expect(rel.intentionConflict).toBeUndefined();
  });

  it('hides broad default-allow inferences by default but keeps specific ones', async () => {
    const { graph } = await loadGraph();
    const filtered = filterGraph(graph, DEFAULT_FILTER);
    const ids = filtered.edges.map((e) => e.id);
    expect(ids).toContain(`${id('audit')}->${id('ledger')}`); // specific-intention
    expect(ids).not.toContain(`${id('audit')}->${id('payments')}`); // default-allow only
    expect(filtered.hiddenBroadEdges).toBeGreaterThan(0);
    expect(filtered.hiddenBroadEdges).toBe(filtered.hiddenEdges);

    const all = filterGraph(graph, { ...DEFAULT_FILTER, includeBroad: true });
    expect(all.edges.map((e) => e.id)).toContain(`${id('audit')}->${id('payments')}`);
    expect(all.hiddenEdges).toBe(0);
  });

  it('shows services without relationships as isolated', async () => {
    const { graph } = await loadGraph();
    const filtered = filterGraph(graph, DEFAULT_FILTER);
    expect(filtered.isolated.map((n) => n.service.ref.name)).toEqual(
      expect.arrayContaining(['consul', 'mesh-gateway', 'legacy-gateway'])
    );
  });

  it('reports no issues for a fully readable mesh', async () => {
    const { graph } = await loadGraph();
    expect(graph.issues).toEqual([]);
    expect(graph.inspected).toBe(6);
  });

  it('lists upstreams and downstreams of a service', async () => {
    const { graph } = await loadGraph();
    const { upstreams, downstreams } = relationshipsOf(graph, id('api'));
    expect(upstreams.map((r) => r.to)).toEqual([id('inventory'), id('payments')]);
    expect(downstreams.map((r) => r.from)).toEqual([id('audit'), id('frontend')]);
  });
});

describe('partial visibility', () => {
  it('turns a forbidden topology request into an issue, not a failure', async () => {
    const base = fixtureFetch();
    const denying: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('service-topology/payments')) {
        return new Response('Permission denied: token lacks permission', { status: 403 });
      }
      return base(input, init);
    };
    const c = new ConsulClient({ fetch: denying });
    const catalog = await fetchServices(c, 'dc1');
    const graph = await fetchMeshTopology(c, catalog, 'dc1');
    expect(graph.issues).toEqual([
      { serviceId: id('payments'), kind: 'forbidden', message: 'Permission denied: token lacks permission' },
    ]);
    expect(graph.inspected).toBe(5);
    // payments -> ledger is only known from payments' own response... but ledger reports it as a downstream.
    expect(graph.edges.has(`${id('payments')}->${id('ledger')}`)).toBe(true);
  });
});

describe('instances and capabilities', () => {
  it('maps per-instance checks with node vs service scope', async () => {
    const { instances } = await fetchServiceInstances(client, 'payments', 'dc1');
    expect(instances).toHaveLength(2);
    const failing = instances.find((i) => i.health === 'critical')!;
    expect(failing.checks.some((c) => c.scope === 'node')).toBe(true);
    expect(failing.checks.find((c) => c.status === 'critical')!.output).toMatch(/seeded failure/);
  });

  it('detects Community Edition (no namespaces endpoint)', async () => {
    expect(await detectCapabilities(client)).toEqual({ namespaces: false });
  });
});
