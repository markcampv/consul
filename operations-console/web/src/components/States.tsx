import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ApiError, type ApiErrorKind } from '../providers/consul/client';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state state-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

const GUIDANCE: Record<ApiErrorKind, { title: string; body: ReactNode }> = {
  unauthorized: {
    title: 'Authentication required',
    body: (
      <>
        Consul requires an ACL token. <Link to="/settings">Add a token in Settings</Link>.
      </>
    ),
  },
  forbidden: {
    title: 'Permission denied by Consul ACLs',
    body: (
      <>
        Your token cannot read this data. Browsing services needs <code>service:read</code> and <code>node:read</code>{' '}
        for the services involved. <Link to="/settings">Change the token in Settings</Link> or ask an operator for a
        policy with read access.
      </>
    ),
  },
  blocked: {
    title: 'Blocked by the console’s read-only policy',
    body: 'The console server only forwards an allowlist of read-only Consul endpoints. This request is not on it.',
  },
  'not-found': { title: 'Not found', body: 'Consul has no record of this resource in the selected datacenter.' },
  unsupported: {
    title: 'Not supported by this Consul',
    body: 'This API is not available on the connected Consul version or edition (some features are Enterprise-only).',
  },
  unavailable: {
    title: 'Consul is unreachable',
    body: (
      <>
        The console could not get a response from Consul. Check that the agent is running and that the console server’s{' '}
        <code>CONSUL_HTTP_ADDR</code> points to it. A 500 with “No cluster leader” means the servers have not elected a
        leader.
      </>
    ),
  },
  'invalid-response': {
    title: 'Unexpected response',
    body: (
      <>
        The response was not valid JSON. Is <code>CONSUL_HTTP_ADDR</code> pointing at a Consul HTTP API?
      </>
    ),
  },
  unknown: { title: 'Request failed', body: 'Consul returned an unexpected error.' },
};

export function ErrorState({ error, what }: { error: unknown; what: string }) {
  const kind: ApiErrorKind = error instanceof ApiError ? error.kind : 'unknown';
  const g = GUIDANCE[kind];
  const detail =
    error instanceof ApiError
      ? `${error.status || 'network'} · ${error.path} · ${error.detail}`
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    <div className={`state state-error error-${kind}`} role="alert">
      <strong>
        Could not load {what}: {g.title}
      </strong>
      <p>{g.body}</p>
      <details>
        <summary>Technical details</summary>
        <code className="block">{detail}</code>
      </details>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state-empty">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'warn' ? 'status' : undefined}>
      {children}
    </div>
  );
}

export function FilteredByACLsNotice({ show }: { show: boolean | undefined }) {
  if (!show) return null;
  return (
    <Notice tone="warn">
      <strong>Partial view.</strong> Consul hid some results because your ACL token cannot read them (
      <code>X-Consul-Results-Filtered-By-ACLs</code>). Counts and relationships below may be incomplete.
    </Notice>
  );
}

export function FetchedAt({ iso, source, onRefresh, busy }: { iso?: string; source?: string; onRefresh?: () => void; busy?: boolean }) {
  if (!iso) return null;
  const t = new Date(iso);
  return (
    <span className="fetched-at">
      <span title={`${t.toISOString()}${source ? ` · ${source}` : ''}`}>Fetched {t.toLocaleTimeString()}</span>
      {onRefresh ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={busy}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      ) : null}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}
