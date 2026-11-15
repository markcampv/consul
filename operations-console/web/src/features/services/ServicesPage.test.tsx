import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { fixtureFetch } from '../../providers/consul/fixtures';
import { renderWithProviders } from '../../test/render';
import { ServicesPage } from './ServicesPage';

const page = (gatewaysOnly = false) => (
  <Routes>
    <Route path="*" element={<ServicesPage gatewaysOnly={gatewaysOnly} />} />
  </Routes>
);

const rowNames = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0]!.textContent);

describe('ServicesPage', () => {
  it('lists services most-severe first and excludes sidecars and gateways', async () => {
    renderWithProviders(page(), { route: '/services' });
    expect(await screen.findByRole('link', { name: 'payments' })).toBeInTheDocument();
    const names = rowNames();
    expect(names[0]).toBe('payments'); // critical
    expect(names[1]).toBe('inventory'); // warning
    expect(names.join(' ')).not.toMatch(/sidecar-proxy|mesh-gateway|legacy-gateway/);
  });

  it('filters by search text and by health', async () => {
    const user = userEvent.setup();
    renderWithProviders(page(), { route: '/services' });
    await screen.findByRole('link', { name: 'payments' });
    await user.type(screen.getByRole('searchbox'), 'legacy');
    expect(rowNames()).toEqual(['legacy-billing']);
    await user.clear(screen.getByRole('searchbox'));
    await user.click(screen.getByRole('button', { name: /Warning/ }));
    expect(rowNames()).toEqual(['inventory']);
  });

  it('shows only gateways on the gateways view', async () => {
    renderWithProviders(page(true), { route: '/gateways' });
    await screen.findByRole('link', { name: 'mesh-gateway' });
    expect(rowNames().sort()).toEqual(['legacy-gateway', 'mesh-gateway']);
  });

  it('warns when Consul filtered results by ACL', async () => {
    const base = fixtureFetch();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const res = await base(input, init);
      if (!String(input).startsWith('/v1/internal/ui/services')) return res;
      const headers = new Headers(res.headers);
      headers.set('X-Consul-Results-Filtered-By-ACLs', 'true');
      return new Response(await res.text(), { status: res.status, headers });
    };
    renderWithProviders(page(), { route: '/services', fetch });
    expect(await screen.findByText(/Partial view\./)).toBeInTheDocument();
  });

  it('explains permission errors with next steps', async () => {
    const base = fixtureFetch();
    const fetch: typeof globalThis.fetch = async (input, init) =>
      String(input).startsWith('/v1/internal/ui/services')
        ? new Response('Permission denied: token with AccessorID abc lacks permission "service:read"', { status: 403 })
        : base(input, init);
    renderWithProviders(page(), { route: '/services', fetch });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Permission denied by Consul ACLs/);
    expect(within(alert).getByRole('link', { name: /Settings/ })).toHaveAttribute('href', '/settings');
  });

  it('explains an unreachable cluster', async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    renderWithProviders(page(), { route: '/services', fetch });
    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent(/Consul is unreachable/);
  });
});
