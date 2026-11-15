import { useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useConsoleConfig } from '../providers/consul/queries';
import { useSettings, type ThemePreference } from './settings';
import { useDatacenter, useDcLink } from './useDatacenter';

const NAV = [
  { to: '/overview', label: 'Overview', icon: '◎' },
  { to: '/topology', label: 'Topology', icon: '⌘' },
  { to: '/services', label: 'Services', icon: '☰' },
  { to: '/gateways', label: 'Gateways', icon: '⇄' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
] as const;

const THEME_NEXT: Record<ThemePreference, ThemePreference> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<ThemePreference, string> = { system: 'System', light: 'Light', dark: 'Dark' };

function DatacenterSelect() {
  const { dc, datacenters, unknown } = useDatacenter();
  const [params, setParams] = useSearchParams();
  if (datacenters.length === 0) return null;
  return (
    <label className="dc-select">
      <span className="sr-only">Datacenter</span>
      <span aria-hidden="true" className="muted">
        DC
      </span>
      <select
        value={dc}
        onChange={(e) => {
          const next = new URLSearchParams(params);
          next.set('dc', e.target.value);
          next.delete('focus');
          setParams(next);
        }}
      >
        {unknown && dc ? <option value={dc}>{dc} (unknown)</option> : null}
        {datacenters.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Shell() {
  const { theme, setTheme } = useSettings();
  const config = useConsoleConfig();
  const link = useDcLink();
  const navigate = useNavigate();
  const location = useLocation();

  // "/" focuses the page's primary search field; "g" then a key navigates.
  useEffect(() => {
    let pendingG = false;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        const el = document.querySelector<HTMLInputElement>('[data-primary-search]');
        if (el) {
          e.preventDefault();
          el.focus();
        }
        return;
      }
      if (pendingG) {
        pendingG = false;
        const dest = { o: '/overview', t: '/topology', s: '/services', w: '/gateways' }[e.key];
        if (dest) navigate(link(dest));
        return;
      }
      if (e.key === 'g') pendingG = true;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, link]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ◈
          </span>
          <span>
            <strong>Consul</strong> Ops Console
          </span>
        </div>
        <nav aria-label="Primary">
          <ul>
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink to={link(n.to)} className={({ isActive }) => (isActive ? 'active' : undefined)}>
                  <span className="nav-icon" aria-hidden="true">
                    {n.icon}
                  </span>
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <p className="sidebar-foot muted">
          Read-only · <kbd>/</kbd> search · <kbd>g</kbd> <kbd>t</kbd> topology
        </p>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <span className="cluster" title="Cluster the console server is connected to">
            <span className="dot live" aria-hidden="true" />
            {config.data?.clusterName ?? 'Consul'}
          </span>
          <DatacenterSelect />
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setTheme(THEME_NEXT[theme])}
            aria-label={`Theme: ${theme}. Switch to ${THEME_NEXT[theme]}`}
            title={`Theme: ${theme}`}
          >
            <span aria-hidden="true" className="theme-swatch" data-pref={theme} />
            {THEME_LABEL[theme]}
          </button>
        </header>
        <main id="main" tabIndex={-1} key={location.pathname}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
