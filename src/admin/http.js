// Runtime admin API for hot-updating the DC list without recompiling anything.
// GET  /health
// GET  /api/dcs                 -> current data centers
// POST /api/dcs                 { id, host, port, secret?, cdn?, mediaOnly? }
// DELETE /api/dcs/:id
// POST /api/dc/this             { id }         -> change this_dc
// GET  /api/endpoints           -> plaintext .tdesktop-endpoints for TDesktop
// GET  /api/config              -> help.getConfig-style summary
// GET  /api/rsa-public-key      -> PKCS#1 PEM (for rebuilding a client)
// POST /api/reload              -> re-read DATA_DIR/dc-endpoints.json
//
// Set ADMIN_TOKEN to require `Authorization: Bearer <token>`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const ENDPOINTS_FILE = '.tdesktop-endpoints';

/** TDesktop's runtime DC override format: `dcId host port [tcpo_only] [media_only]`. */
export function endpointsText(dcs = []) {
  return `${dcs.filter((d) => d && d.host && d.port).map((d) => (
    `${Number(d.id) || 1} ${d.host} ${Number(d.port) || 10443}${d.tcpoOnly ? ' tcpo_only' : ''}${d.mediaOnly ? ' media_only' : ''}`
  )).join('\n')}\n`;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function text(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON body');
  }
}

export function createAdminServer({
  registry,
  config = {},
  keys = null,
  host = '127.0.0.1',
  port = 18080,
  token = '',
} = {}) {
  const secret = token || process.env.ADMIN_TOKEN || '';
  const server = http.createServer(async (req, res) => {
    try {
      if (secret && req.headers.authorization !== `Bearer ${secret}`) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      const url = new URL(req.url, `http://${host}:${port}`);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      if (pathname === '/health' && req.method === 'GET') {
        json(res, 200, { ok: true, dcs: registry.listDcs().length });
        return;
      }

      if (pathname === '/api/dcs' && req.method === 'GET') {
        json(res, 200, { this_dc: registry.thisDc, dcs: registry.listDcs() });
        return;
      }

      if (pathname === '/api/dcs' && req.method === 'POST') {
        const body = await readBody(req);
        const dc = registry.registerDc(body);
        json(res, 200, { ok: true, dc });
        return;
      }

      const match = pathname.match(/^\/api\/dcs\/(\d+)$/);
      if (match && req.method === 'DELETE') {
        const ok = registry.removeDc(Number(match[1]));
        json(res, ok ? 200 : 404, { ok });
        return;
      }

      if (pathname === '/api/dc/this' && req.method === 'POST') {
        const body = await readBody(req);
        registry.thisDc = Number(body.id ?? body.this_dc ?? body.thisDc) | 0;
        json(res, 200, { ok: true, this_dc: registry.thisDc });
        return;
      }

      if (pathname === '/api/endpoints' && req.method === 'GET') {
        text(res, 200, endpointsText(registry.listDcs()));
        return;
      }

      if (pathname === '/api/config' && req.method === 'GET') {
        json(res, 200, registry.getDataCenterConfig(false));
        return;
      }

      if (pathname === '/api/rsa-public-key' && req.method === 'GET') {
        if (!keys?.publicPem) {
          json(res, 404, { error: 'public key unavailable' });
          return;
        }
        text(res, 200, keys.publicPem);
        return;
      }

      if (pathname === '/api/reload' && req.method === 'POST') {
        const result = reloadFromFile(registry, config.dataDir || './data');
        json(res, 200, result);
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  });
  server.adminToken = secret;
  return server;
}

/**
 * Editable DC source of truth: DATA_DIR/dc-endpoints.json
 * { "dcs": [{ "id": 1, "host": "1.2.3.4", "port": 10443 }], "this_dc": 1 }
 * Calling reloadFromFile() hot-applies it; no restart or rebuild needed.
 */
export function reloadFromFile(registry, dataDir = './data') {
  const file = path.join(dataDir, 'dc-endpoints.json');
  if (!fs.existsSync(file)) return { ok: false, error: 'file not found', file };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dcs = Array.isArray(parsed.dcs) ? parsed.dcs : Array.isArray(parsed) ? parsed : [];
  for (const dc of dcs) registry.registerDc(dc);
  if (parsed.this_dc !== undefined) registry.thisDc = Number(parsed.this_dc) | 0;
  return { ok: true, file, dcs: registry.listDcs(), this_dc: registry.thisDc };
}

export function watchDcFile(registry, dataDir = './data', onChange = null) {
  const file = path.join(dataDir, 'dc-endpoints.json');
  if (!fs.existsSync(file)) return () => {};
  let timer = null;
  const cb = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const result = reloadFromFile(registry, dataDir);
        if (result.ok) onChange?.(result);
      } catch (err) {
        console.error('[admin] dc-endpoints reload failed', err.message);
      }
    }, 200);
  };
  const watcher = fs.watch(file, cb);
  return () => watcher.close();
}

export default createAdminServer;
