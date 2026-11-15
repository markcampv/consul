/**
 * Minimal Consul HTTP client for the browser.
 *
 * Requests go to the same origin (`/v1/...`): the console server or the Vite
 * dev server proxies them to Consul. The browser never talks to Consul or to
 * Envoy directly, and never chooses the upstream address.
 */

export type ApiErrorKind =
  | 'unauthorized' // 401: missing or invalid token
  | 'forbidden' // 403 from Consul: token lacks permission (or ACL not found)
  | 'blocked' // 403 from the console server: endpoint not on the read-only allowlist
  | 'not-found' // 404 for a resource
  | 'unsupported' // 404 for an endpoint (feature/edition not available)
  | 'unavailable' // network error, 5xx, Consul unreachable, no leader
  | 'invalid-response'
  | 'unknown';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly path: string;
  readonly detail: string;

  constructor(kind: ApiErrorKind, status: number, path: string, detail: string) {
    super(`${kind} (${status}) for ${path}: ${detail}`);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.path = path;
    this.detail = detail;
  }
}

export interface ResponseMeta {
  /** Consul removed some results because the token lacks read permission. */
  filteredByACLs: boolean;
  defaultACLPolicy?: 'allow' | 'deny';
  knownLeader?: boolean;
  fetchedAt: string;
  /** Method and path (without query) that produced this response. */
  source: string;
}

export interface ApiResponse<T> {
  data: T;
  meta: ResponseMeta;
}

export type QueryValue = string | number | boolean | undefined | null;

/** Build a request path with query params in a stable (sorted) order. Empty-string values are kept. */
export function buildPath(path: string, query: Record<string, QueryValue> = {}): string {
  const params = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return params.length ? `${path}?${params.join('&')}` : path;
}

export function classifyError(status: number, body: string, headers: Headers, path: string): ApiError {
  const detail = body.trim().slice(0, 500) || `HTTP ${status}`;
  if (status === 401) return new ApiError('unauthorized', status, path, detail);
  if (status === 403) {
    const kind = headers.get('x-console-blocked') ? 'blocked' : 'forbidden';
    return new ApiError(kind, status, path, detail);
  }
  if (status === 404) {
    // Consul answers unknown endpoints with this text; resources yield an empty 404.
    const unsupported = /not a recognized HTTP API endpoint|Invalid URL path/i.test(body);
    return new ApiError(unsupported ? 'unsupported' : 'not-found', status, path, detail);
  }
  if (status === 429 || status >= 500) return new ApiError('unavailable', status, path, detail);
  return new ApiError('unknown', status, path, detail);
}

export interface ClientOptions {
  /** Returns the ACL token to send, if any. Read on every request so token changes apply immediately. */
  token?: () => string | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class ConsulClient {
  private readonly opts: Required<Pick<ClientOptions, 'fetch' | 'now'>> & ClientOptions;

  constructor(opts: ClientOptions = {}) {
    this.opts = {
      ...opts,
      fetch: opts.fetch ?? ((...args) => globalThis.fetch(...args)),
      now: opts.now ?? (() => new Date()),
    };
  }

  async get<T>(path: string, query: Record<string, QueryValue> = {}, signal?: AbortSignal): Promise<ApiResponse<T>> {
    if (!path.startsWith('/v1/')) throw new Error(`refusing non-API path ${path}`);
    const url = buildPath(path, query);
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = this.opts.token?.();
    if (token) headers['X-Consul-Token'] = token;

    let res: Response;
    try {
      res = await this.opts.fetch(url, { method: 'GET', headers, signal, credentials: 'same-origin' });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      throw new ApiError('unavailable', 0, path, (e as Error)?.message ?? 'network error');
    }

    const text = await res.text();
    if (!res.ok) throw classifyError(res.status, text, res.headers, path);

    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new ApiError('invalid-response', res.status, path, 'response was not JSON');
    }

    const policy = res.headers.get('x-consul-default-acl-policy');
    const leader = res.headers.get('x-consul-knownleader');
    return {
      data,
      meta: {
        filteredByACLs: res.headers.get('x-consul-results-filtered-by-acls') === 'true',
        defaultACLPolicy: policy === 'allow' || policy === 'deny' ? policy : undefined,
        knownLeader: leader === null ? undefined : leader === 'true',
        fetchedAt: this.opts.now().toISOString(),
        source: `GET ${path}`,
      },
    };
  }
}
