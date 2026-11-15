import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const THEME_KEY = 'opsconsole:theme';
const TOKEN_KEY = 'opsconsole:token';

/** Storage can throw (private mode, blocked site data); every access is guarded. */
function store(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    return window[kind];
  } catch {
    return null;
  }
}
function read(kind: 'localStorage' | 'sessionStorage', key: string): string | null {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(kind: 'localStorage' | 'sessionStorage', key: string, value: string | null) {
  try {
    const s = store(kind);
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* ignore */
  }
}

interface SettingsValue {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme(theme: ThemePreference): void;
  /** True when a token is configured. The value itself is only exposed through `tokenRef`. */
  hasToken: boolean;
  rememberToken: boolean;
  /** Stored in sessionStorage, or localStorage when `remember` is true. */
  setToken(token: string, remember: boolean): void;
  clearToken(): void;
  /** Read by the API client on every request. */
  tokenRef: { readonly current: string };
  /** Increments when the token changes, so data can be refetched. */
  tokenVersion: number;
}

const SettingsContext = createContext<SettingsValue | null>(null);

function systemTheme(): ResolvedTheme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(() => {
    const t = read('localStorage', THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  });
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);
  const initialLocal = read('localStorage', TOKEN_KEY);
  const tokenRef = useRef<string>(read('sessionStorage', TOKEN_KEY) ?? initialLocal ?? '');
  const [hasToken, setHasToken] = useState(tokenRef.current !== '');
  const [rememberToken, setRemember] = useState(initialLocal !== null);
  const [tokenVersion, setTokenVersion] = useState(0);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = theme === 'system' ? system : theme;
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const setTheme = useCallback((t: ThemePreference) => {
    setThemeState(t);
    write('localStorage', THEME_KEY, t === 'system' ? null : t);
  }, []);

  const setToken = useCallback((token: string, remember: boolean) => {
    const value = token.trim();
    tokenRef.current = value;
    write('sessionStorage', TOKEN_KEY, value || null);
    write('localStorage', TOKEN_KEY, remember && value ? value : null);
    setHasToken(value !== '');
    setRemember(remember && value !== '');
    setTokenVersion((v) => v + 1);
  }, []);

  const clearToken = useCallback(() => setToken('', false), [setToken]);

  const value = useMemo<SettingsValue>(
    () => ({ theme, resolvedTheme, setTheme, hasToken, rememberToken, setToken, clearToken, tokenRef, tokenVersion }),
    [theme, resolvedTheme, setTheme, hasToken, rememberToken, setToken, clearToken, tokenVersion]
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider');
  return ctx;
}
