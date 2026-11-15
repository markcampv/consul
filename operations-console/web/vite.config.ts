/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createFixtureLookup } from './src/providers/consul/fixtures';

/**
 * Development modes:
 *   pnpm dev       proxy /v1 to CONSUL_HTTP_ADDR (default http://127.0.0.1:8500)
 *   pnpm dev:mock  serve deterministic fixtures recorded from a real agent
 *
 * The Go console server (operations-console/server) is the production
 * security boundary. These middlewares mirror its read-only behaviour so
 * development cannot accidentally depend on write access.
 */

function sendJSON(res: Parameters<Connect.NextHandleFunction>[1], status: number, body: unknown, headers: Record<string, string> = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

function consoleDevServer(mode: 'mock' | 'proxy', target: string): Plugin {
  const lookup = mode === 'mock' ? createFixtureLookup() : undefined;
  return {
    name: 'operations-console-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (url === '/console/config.json') {
          return sendJSON(res, 200, {
            clusterName: mode === 'mock' ? 'demo (recorded fixtures)' : `dev proxy → ${target}`,
            mode,
            readOnly: true,
          });
        }
        if (!url.startsWith('/v1/')) return next();
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.setHeader('X-Console-Blocked', 'method');
          return sendJSON(res, 405, { error: 'The operations console is read-only.' });
        }
        if (!lookup) return next(); // fall through to the Vite proxy
        const hit = lookup(url);
        if (!hit) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain');
          return res.end('Invalid URL path: not a recognized HTTP API endpoint (no fixture recorded)');
        }
        res.statusCode = hit.status;
        for (const [k, v] of Object.entries(hit.headers)) res.setHeader(k, v);
        res.end(typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.CONSUL_HTTP_ADDR || 'http://127.0.0.1:8500';
  const isMock = mode === 'mock';
  return {
    plugins: [react(), consoleDevServer(isMock ? 'mock' : 'proxy', target)],
    server: {
      port: Number(env.CONSOLE_DEV_PORT || 5173),
      strictPort: true,
      proxy: isMock ? undefined : { '/v1': { target, changeOrigin: true } },
    },
    build: {
      sourcemap: true,
      chunkSizeWarningLimit: 800,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
    },
  };
});
