#!/usr/bin/env node
// Record real Consul HTTP API responses into a deterministic fixture file used
// by the console's mock mode, unit tests and Playwright tests.
//
//   CONSUL_HTTP_ADDR=http://127.0.0.1:8500 node scripts/record-fixtures.mjs [out.json]
//
// Only read-only GET endpoints that the console uses are recorded. The ACL
// token (if any) is read from CONSUL_HTTP_TOKEN and is never written to disk.
// Volatile values (indexes, timestamps) are normalised so re-recording the
// same scenario produces a minimal diff.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const addr = (process.env.CONSUL_HTTP_ADDR || 'http://127.0.0.1:8500').replace(/\/$/, '');
const out = resolve(
  process.argv[2] || new URL('../web/src/providers/consul/fixtures/demo.json', import.meta.url).pathname
);
const token = process.env.CONSUL_HTTP_TOKEN;

const KEEP_HEADERS = [
  'content-type',
  'x-consul-default-acl-policy',
  'x-consul-results-filtered-by-acls',
  'x-consul-knownleader',
];

async function get(path) {
  const res = await fetch(addr + path, { headers: token ? { 'X-Consul-Token': token } : {} });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const headers = {};
  for (const h of KEEP_HEADERS) {
    const v = res.headers.get(h);
    if (v !== null) headers[h] = v;
  }
  return { status: res.status, headers, body };
}

// Strip values that change on every run.
function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'CreateIndex' || k === 'ModifyIndex') o[k] = 1;
      else o[k] = normalise(v);
    }
    return o;
  }
  return value;
}

const fixtures = {};
async function record(path) {
  const r = await get(path);
  fixtures[path] = { ...r, body: normalise(r.body) };
  return r;
}

const dcs = await record('/v1/catalog/datacenters');
if (dcs.status !== 200) {
  console.error(`cannot reach Consul at ${addr}: HTTP ${dcs.status}`);
  process.exit(1);
}
await record('/v1/status/leader');
await record('/v1/namespaces');
for (const dc of dcs.body) {
  const services = await record(`/v1/internal/ui/services?dc=${dc}`);
  for (const svc of services.body) {
    if (svc.Kind === 'connect-proxy') continue;
    await record(`/v1/health/service/${encodeURIComponent(svc.Name)}?dc=${dc}`);
    const kind = svc.Kind || '';
    if (['', 'ingress-gateway', 'api-gateway'].includes(kind)) {
      await record(`/v1/internal/ui/service-topology/${encodeURIComponent(svc.Name)}?dc=${dc}&kind=${kind}`);
    }
  }
}

const sorted = Object.fromEntries(Object.entries(fixtures).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(
  out,
  JSON.stringify(
    {
      _comment:
        'Recorded from a real Consul agent by operations-console/scripts/record-fixtures.mjs. Do not edit by hand; re-record instead.',
      responses: sorted,
    },
    null,
    2
  ) + '\n'
);
console.log(`recorded ${Object.keys(sorted).length} responses to ${out}`);
