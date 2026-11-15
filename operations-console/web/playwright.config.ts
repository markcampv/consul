import { defineConfig, devices } from '@playwright/test';

/**
 * By default runs against the Vite dev server in mock mode (deterministic
 * fixtures recorded from a real agent). Set E2E_BASE_URL to run the same
 * specs against a live console server, e.g. http://127.0.0.1:9500 in front
 * of a `consul agent -dev` seeded with scripts/seed-dev-mesh.sh.
 */
const external = process.env.E2E_BASE_URL;
const port = Number(process.env.CONSOLE_DEV_PORT || 5174);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: external ?? `http://127.0.0.1:${port}`,
    trace: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: external
    ? undefined
    : {
        command: `pnpm exec vite --mode mock --port ${port} --strictPort`,
        url: `http://127.0.0.1:${port}/console/config.json`,
        reuseExistingServer: !process.env.CI,
        env: { CONSOLE_DEV_PORT: String(port) },
      },
});
