/**
 * Deterministic fixtures recorded from a real Consul agent
 * (operations-console/scripts/record-fixtures.mjs). Used by the Vite mock
 * mode, unit tests and Playwright tests. Pure: no Node or DOM APIs.
 */
import demo from './demo.json';

export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type FixtureSet = Record<string, RecordedResponse>;

export const demoFixtures = demo.responses as unknown as FixtureSet;

/** Path plus query parameters sorted by key, so lookup is order-insensitive. */
export function canonicalKey(pathWithQuery: string): string {
  const [path = '', query = ''] = pathWithQuery.split('?', 2);
  if (!query) return decodeURIComponent(path);
  const params = query
    .split('&')
    .filter(Boolean)
    .map((p) => {
      const [k = '', v = ''] = p.split('=', 2);
      return [decodeURIComponent(k), decodeURIComponent(v)] as const;
    })
    .sort(([a], [b]) => a.localeCompare(b));
  return `${decodeURIComponent(path)}?${params.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

export function createFixtureLookup(fixtures: FixtureSet = demoFixtures) {
  const index = new Map<string, RecordedResponse>();
  for (const [k, v] of Object.entries(fixtures)) index.set(canonicalKey(k), v);
  return (pathWithQuery: string): RecordedResponse | undefined => index.get(canonicalKey(pathWithQuery));
}

/** A `fetch` implementation backed by fixtures, for tests. Unknown paths return 404. */
export function fixtureFetch(fixtures: FixtureSet = demoFixtures): typeof fetch {
  const lookup = createFixtureLookup(fixtures);
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const hit = lookup(url);
    if (!hit) {
      return new Response('Invalid URL path: not a recognized HTTP API endpoint', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      });
    }
    const body = typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body);
    return new Response(body, { status: hit.status, headers: hit.headers });
  };
}
