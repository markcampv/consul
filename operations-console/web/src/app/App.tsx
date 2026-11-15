import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ApiError, ConsulClient } from '../providers/consul/client';
import { ConsulClientContext } from '../providers/consul/queries';
import { OverviewPage } from '../features/overview/OverviewPage';
import { ServiceDetailPage } from '../features/services/ServiceDetailPage';
import { ServicesPage } from '../features/services/ServicesPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { TopologyPage } from '../features/topology/TopologyPage';
import { EmptyState } from '../components/States';
import { SettingsProvider, useSettings } from './settings';
import { Shell } from './Shell';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Retrying permission or "unsupported" errors only delays the message.
        retry: (count, err) =>
          count < 2 && !(err instanceof ApiError && ['unauthorized', 'forbidden', 'blocked', 'unsupported', 'not-found'].includes(err.kind)),
      },
    },
  });
}

function DataLayer({ children }: { children: React.ReactNode }) {
  const { tokenRef, tokenVersion } = useSettings();
  const [queryClient] = useState(makeQueryClient);
  const client = useMemo(() => new ConsulClient({ token: () => tokenRef.current || undefined }), [tokenRef]);

  // New token = new permissions: drop everything cached under the old one.
  useEffect(() => {
    if (tokenVersion > 0) void queryClient.resetQueries();
  }, [tokenVersion, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <ConsulClientContext.Provider value={client}>{children}</ConsulClientContext.Provider>
    </QueryClientProvider>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/overview" replace />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="topology" element={<TopologyPage />} />
        <Route path="services" element={<ServicesPage />} />
        <Route path="services/:name" element={<ServiceDetailPage />} />
        <Route path="gateways" element={<ServicesPage gatewaysOnly />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<EmptyState title="Page not found" />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <SettingsProvider>
      <DataLayer>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </DataLayer>
    </SettingsProvider>
  );
}
