import { expect, test } from '@playwright/test';

// These assertions describe the seeded dev mesh (scripts/seed-dev-mesh.sh),
// which is also what the mock fixtures were recorded from.

test('overview highlights unhealthy services and relationship evidence', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/overview/);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  const attention = page.locator('section', { has: page.getByRole('heading', { name: 'Needs attention' }) });
  await expect(attention.getByRole('link', { name: 'payments' })).toBeVisible();
  await expect(attention.getByRole('link', { name: 'inventory' })).toBeVisible();
  const rels = page.locator('section', { has: page.getByRole('heading', { name: 'Relationships' }) });
  await expect(rels.getByText(/not observed traffic/)).toBeVisible();
  await expect(rels.getByText(/broad-policy inferences/)).toBeVisible();
});

test('service catalog search, health filter and detail view', async ({ page }) => {
  await page.goto('/services');
  await expect(page.getByRole('link', { name: 'payments' })).toBeVisible(); // app mounted
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.keyboard.type('pay');
  await expect(page.getByRole('row')).toHaveCount(2); // header + payments
  await page.getByRole('searchbox').fill('');
  await page.getByRole('button', { name: /Critical/ }).click();
  await expect(page).toHaveURL(/health=critical/);
  await page.getByRole('link', { name: 'payments' }).click();

  await expect(page.getByRole('heading', { name: /payments/ })).toBeVisible();
  const instances = page.locator('section', { has: page.getByRole('heading', { name: 'Instances' }) });
  await expect(instances.getByRole('row')).toHaveCount(3);
  await instances.getByText(/checks$/).first().click();
  await instances.getByText(/checks$/).last().click();
  await expect(instances.getByText(/seeded failure/)).toBeVisible();

  const rel = page.locator('section', { has: page.getByRole('heading', { name: 'Relationships' }) });
  await expect(rel.getByRole('link', { name: 'ledger' })).toBeVisible();
  await expect(rel.getByRole('link', { name: 'legacy-billing' })).toBeVisible();
});

test('topology: focus a service, inspect a denied relationship', async ({ page }) => {
  await page.goto('/topology');
  await expect(page.locator('.react-flow__node-service').first()).toBeVisible();
  await expect(page.getByText(/No line represents observed traffic/)).toBeVisible();

  // An <input list> is exposed as a combobox.
  await page.getByRole('combobox', { name: /Focus a service/ }).fill('api');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/focus=api/);
  const panel = page.getByRole('complementary', { name: 'Details for api' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('link', { name: 'inventory' })).toBeVisible();

  await page.locator('.react-flow__edge.edge-denied').first().click({ force: true });
  const edgePanel = page.getByRole('complementary', { name: 'Relationship details' });
  await expect(edgePanel).toBeVisible();
  await expect(edgePanel.getByText('Denied', { exact: true })).toBeVisible();
  await expect(edgePanel.getByText(/decided by an exact intention/)).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(edgePanel).toBeHidden();
});

test('topology: broad-policy inferences are opt-in and counted', async ({ page }) => {
  await page.goto('/topology');
  const summary = page.locator('.topo-summary');
  await expect(summary).toBeVisible();
  const before = Number((await summary.textContent())!.match(/with (\d+) visible/)![1]);
  await page.getByLabel(/Broad-policy inferences/).check();
  await expect(summary).not.toHaveText(new RegExp(`with ${before} visible`));
  const after = Number((await summary.textContent())!.match(/with (\d+) visible/)![1]);
  expect(after).toBeGreaterThan(before);
});

test('theme toggle switches to dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/overview');
  const toggle = page.getByRole('button', { name: /^Theme:/ });
  await toggle.click(); // system -> light
  await toggle.click(); // light -> dark
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('@mobile layout has no horizontal scroll', async ({ page }) => {
  for (const path of ['/overview', '/services', '/topology?focus=frontend']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
