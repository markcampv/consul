import { useState } from 'react';
import { useSettings, type ThemePreference } from '../../app/settings';
import { Notice, PageHeader } from '../../components/States';
import { useCapabilities, useConsoleConfig } from '../../providers/consul/queries';

export function SettingsPage() {
  const s = useSettings();
  const config = useConsoleConfig();
  const caps = useCapabilities();
  const [draft, setDraft] = useState('');
  const [remember, setRemember] = useState(s.rememberToken);
  const [saved, setSaved] = useState<string | null>(null);

  return (
    <div className="page page-narrow">
      <PageHeader title="Settings" />

      <section className="card section" aria-labelledby="theme-h">
        <h2 id="theme-h">Appearance</h2>
        <fieldset className="radio-row">
          <legend>Theme</legend>
          {(['system', 'light', 'dark'] as ThemePreference[]).map((t) => (
            <label key={t}>
              <input type="radio" name="theme" value={t} checked={s.theme === t} onChange={() => s.setTheme(t)} /> {t}
            </label>
          ))}
        </fieldset>
      </section>

      <section className="card section" aria-labelledby="token-h">
        <h2 id="token-h">Consul ACL token</h2>
        <p className="muted">
          Sent as <code>X-Consul-Token</code> with every request, so Consul enforces your permissions. The console server
          forwards it and never stores or logs it. Read-only browsing needs <code>service:read</code> and{' '}
          <code>node:read</code>.
        </p>
        <p>
          Status: <strong>{s.hasToken ? (s.rememberToken ? 'token set (remembered on this device)' : 'token set (this tab session)') : 'no token (anonymous)'}</strong>
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            s.setToken(draft, remember);
            setDraft('');
            setSaved(draft.trim() ? 'Token saved. Data will reload with the new permissions.' : 'Token cleared.');
          }}
        >
          <label className="field">
            <span>Token secret ID</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={s.hasToken ? '•••••••• (enter a new token to replace)' : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this
            device (stored in localStorage; avoid on shared machines)
          </label>
          <div className="row">
            <button type="submit" className="btn btn-primary">
              Save token
            </button>
            {s.hasToken ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  s.clearToken();
                  setSaved('Token cleared.');
                }}
              >
                Clear token
              </button>
            ) : null}
          </div>
          {saved ? <p role="status" className="small">{saved}</p> : null}
        </form>
      </section>

      <section className="card section" aria-labelledby="conn-h">
        <h2 id="conn-h">Connection</h2>
        {config.isError ? (
          <Notice tone="warn">
            Could not read <code>/console/config.json</code>. Is the console served by the console server or the Vite dev
            server?
          </Notice>
        ) : null}
        <dl className="kv">
          <dt>Cluster</dt>
          <dd>{config.data?.clusterName ?? '…'}</dd>
          <dt>Mode</dt>
          <dd>{config.data?.mode ?? '…'}</dd>
          <dt>Access</dt>
          <dd>{config.data ? (config.data.readOnly ? 'Read-only (write requests are rejected)' : 'Read/write') : '…'}</dd>
          <dt>Namespaces</dt>
          <dd>{caps.data ? (caps.data.namespaces ? 'Available' : 'Not available (Community Edition or disabled)') : '…'}</dd>
        </dl>
        <p className="muted small">
          The Consul address is set on the console server (<code>CONSUL_HTTP_ADDR</code>). Browsers cannot choose it, so
          the console cannot be used to reach arbitrary hosts.
        </p>
      </section>
    </div>
  );
}
