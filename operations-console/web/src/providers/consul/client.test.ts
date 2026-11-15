import { ApiError, ConsulClient, buildPath, classifyError } from './client';

describe('buildPath', () => {
  it('sorts params, keeps empty strings and drops undefined', () => {
    expect(buildPath('/v1/x', { kind: '', dc: 'dc1', ns: undefined })).toBe('/v1/x?dc=dc1&kind=');
  });
});

describe('classifyError', () => {
  const h = (init: Record<string, string> = {}) => new Headers(init);
  it.each([
    [401, '', {}, 'unauthorized'],
    [403, 'Permission denied: token lacks service:read', {}, 'forbidden'],
    [403, 'blocked', { 'x-console-blocked': 'path' }, 'blocked'],
    [404, 'Invalid URL path: not a recognized HTTP API endpoint', {}, 'unsupported'],
    [404, '', {}, 'not-found'],
    [500, 'No cluster leader', {}, 'unavailable'],
    [429, '', {}, 'unavailable'],
    [418, '', {}, 'unknown'],
  ])('%i %s -> %s', (status, body, headers, kind) => {
    expect(classifyError(status, body, h(headers), '/v1/x').kind).toBe(kind);
  });
});

describe('ConsulClient', () => {
  it('sends the token header and reads response metadata', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const client = new ConsulClient({
      token: () => 'secret-token',
      now: () => new Date('2026-01-01T00:00:00Z'),
      fetch: async (url, init) => {
        calls.push([String(url), init]);
        return new Response('["dc1"]', {
          status: 200,
          headers: { 'X-Consul-Default-ACL-Policy': 'deny', 'X-Consul-Results-Filtered-By-ACLs': 'true' },
        });
      },
    });
    const res = await client.get<string[]>('/v1/catalog/datacenters');
    expect(res.data).toEqual(['dc1']);
    expect(res.meta).toEqual({
      filteredByACLs: true,
      defaultACLPolicy: 'deny',
      knownLeader: undefined,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      source: 'GET /v1/catalog/datacenters',
    });
    expect((calls[0]![1]!.headers as Record<string, string>)['X-Consul-Token']).toBe('secret-token');
  });

  it('omits the token header when no token is set', async () => {
    let headers: Record<string, string> = {};
    const client = new ConsulClient({
      fetch: async (_url, init) => {
        headers = init!.headers as Record<string, string>;
        return new Response('[]');
      },
    });
    await client.get('/v1/catalog/datacenters');
    expect(headers).not.toHaveProperty('X-Consul-Token');
  });

  it('maps network failures to unavailable', async () => {
    const client = new ConsulClient({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(client.get('/v1/catalog/datacenters')).rejects.toMatchObject({ kind: 'unavailable', status: 0 });
  });

  it('rejects non-JSON success bodies', async () => {
    const client = new ConsulClient({ fetch: async () => new Response('<html>') });
    await expect(client.get('/v1/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses paths outside /v1/', async () => {
    const client = new ConsulClient({ fetch: async () => new Response('[]') });
    await expect(client.get('/console/x')).rejects.toThrow(/non-API path/);
  });
});
