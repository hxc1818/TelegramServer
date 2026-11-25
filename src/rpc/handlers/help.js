import * as C from './codecs.js';
import { str } from './parsers.js';
import { configOf } from './context.js';

export function getConfig(r, ctx) {
  const config = configOf(ctx);
  const now = Math.floor(Date.now() / 1000);
  return C.config({
    date: now,
    expires: now + 3600,
    thisDc: config.serverId ?? 1,
    dcOptions: [{ id: config.serverId ?? 1, ip: config.publicIp || '127.0.0.1', port: config.listenPort ?? 10443 }],
  });
}

export function getNearestDc(r, ctx) {
  const config = configOf(ctx);
  return C.nearestDc({ country: 'US', thisDc: config.serverId ?? 1, nearestDc: config.serverId ?? 1 });
}

export function getAppUpdate(r) {
  str(r, 'source', ''); // source is ignored; we have no app update to offer
  return C.noAppUpdate();
}
