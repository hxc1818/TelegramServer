import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DcRegistry } from '../src/store/dc.js';
import { createAdminServer, endpointsText, reloadFromFile } from '../src/admin/http.js';

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-admin-'));
  return dir;
}

async function withServer(t, opts, fn) {
  const registry = new DcRegistry(opts.dir, { dcs: [{ id: 1, host: '127.0.0.1', port: 10443 }] });
  const server = createAdminServer({ registry, config: { dataDir: opts.dir }, keys: { publicPem: 'PEM' }, token: opts.token || '' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); registry.close(); fs.rmSync(opts.dir, { recursive: true, force: true }); });
  await fn(base, registry);
}

test('endpointsText uses TDesktop .tdesktop-endpoints wire format', () => {
  const out = endpointsText([
    { id: 1, host: '1.2.3.4', port: 10443, tcpoOnly: true },
    { id: 2, host: '5.6.7.8', port: 443, mediaOnly: true },
  ]);
  assert.equal(out, '1 1.2.3.4 10443 tcpo_only\n2 5.6.7.8 443 media_only\n');
});

test('admin API hot-updates DCs and serves endpoints file', async (t) => {
  await withServer(t, { dir: tempDir() }, async (base, registry) => {
    let res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);

    res = await fetch(`${base}/api/dcs`);
    assert.equal((await res.json()).dcs.length, 1);

    res = await fetch(`${base}/api/dcs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 2, host: '10.0.0.5', port: 10444 }),
    });
    assert.equal(res.status, 200);
    assert.equal(registry.listDcs().length, 2);

    res = await fetch(`${base}/api/endpoints`);
    const endpoints = await res.text();
    assert.match(endpoints, /1 127\.0\.0\.1 10443/);
    assert.match(endpoints, /2 10\.0\.0\.5 10444/);

    res = await fetch(`${base}/api/dc/this`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 2 }),
    });
    assert.equal((await res.json()).this_dc, 2);
    res = await fetch(`${base}/api/config`);
    assert.equal((await res.json()).thisDc, 2);
  });
});

test('admin API requires bearer token and can reload DC file', async (t) => {
  const dir = tempDir();
  await withServer(t, { dir, token: 'secret-token' }, async (base, registry) => {
    let res = await fetch(`${base}/api/dcs`);
    assert.equal(res.status, 401);
    res = await fetch(`${base}/api/dcs`, { headers: { authorization: 'Bearer secret-token' } });
    assert.equal(res.status, 200);

    fs.writeFileSync(path.join(dir, 'dc-endpoints.json'), JSON.stringify({
      dcs: [{ id: 3, host: '192.168.1.9', port: 20443 }],
      this_dc: 3,
    }));
    res = await fetch(`${base}/api/reload`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
    });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.this_dc, 3);
    assert.ok(registry.getDc(3));

    const direct = reloadFromFile(registry, dir);
    assert.equal(direct.ok, true);
  });
});
