import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { renderWithProviders } from '../../test/render';
import { TopologyPage } from './TopologyPage';

const page = (
  <Routes>
    <Route path="*" element={<TopologyPage />} />
  </Routes>
);

describe('TopologyPage', () => {
  it('summarises the graph and states that edges are not observed traffic', async () => {
    renderWithProviders(page, { route: '/topology' });
    expect(await screen.findByText(/services with \d+ visible relationships/)).toBeInTheDocument();
    expect(screen.getByText(/not observed traffic/)).toBeInTheDocument();
    expect(screen.getByText(/No line represents observed traffic/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Broad-policy inferences/).closest('label')).toHaveTextContent(/hidden/);
  });

  it('opens the detail panel for a focused service from the URL', async () => {
    renderWithProviders(page, { route: '/topology?focus=frontend' });
    const panel = await screen.findByRole('complementary', { name: 'Details for frontend' });
    expect(within(panel).getByRole('link', { name: 'api' })).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'checkout' })).toBeInTheDocument();
    expect(within(panel).getByText('virtual')).toBeInTheDocument();
  });

  it('warns when the focused service does not exist', async () => {
    renderWithProviders(page, { route: '/topology?focus=nope' });
    expect(await screen.findByText(/“nope” is not part of the topology/)).toBeInTheDocument();
  });
});
