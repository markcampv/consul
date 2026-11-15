import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { SettingsProvider } from '../app/settings';
import { ConsulClient } from '../providers/consul/client';
import { fixtureFetch } from '../providers/consul/fixtures';
import { ConsulClientContext } from '../providers/consul/queries';

/** Render with real providers, backed by fixtures recorded from a Consul dev agent. */
export function renderWithProviders(ui: ReactElement, { route = '/', fetch = fixtureFetch() }: { route?: string; fetch?: typeof globalThis.fetch } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = new ConsulClient({ fetch });
  return render(
    <SettingsProvider>
      <QueryClientProvider client={queryClient}>
        <ConsulClientContext.Provider value={client}>
          <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
        </ConsulClientContext.Provider>
      </QueryClientProvider>
    </SettingsProvider>
  );
}
