import { TLBuffer } from '../../tl/buffer.js';
import * as C from './codecs.js';
import { isReader, long, readInputUser } from './parsers.js';
import { currentUser } from './context.js';

function resolveInputUser(store, input, ctx) {
  if (!input) return null;
  if (input.type === 'self' || input.type === 'empty') return currentUser(store, ctx);
  if (input.type === 'user' && input.id) return store.getUser(input.id);
  return null;
}

export function getUsers(r, ctx) {
  const store = ctx.store;
  let inputs;
  if (isReader(r)) {
    inputs = r.vector((rr) => readInputUser(rr));
  } else if (Array.isArray(r)) {
    inputs = r.map((x) => readInputUser(x));
  } else {
    inputs = (r?.id || r?.users || []).map((x) => readInputUser(x));
  }
  const users = inputs.map((input) => resolveInputUser(store, input, ctx)).filter(Boolean);
  const b = new TLBuffer();
  b.putVector(users, (u, bb) => bb.putRaw(C.user({ ...u, self: u.id === ctx.userId })));
  return b.buffer;
}

export function getFullUser(r, ctx) {
  const store = ctx.store;
  const input = isReader(r) ? readInputUser(r) : readInputUser(r, 'id');
  const user = resolveInputUser(store, input, ctx) || currentUser(store, ctx);
  return C.userFull({ id: user?.id || 0, commonChatsCount: 0 });
}

export function getContacts(r, ctx) {
  const store = ctx.store;
  long(r, 'hash', 0n); // hash is ignored: we always send the full list
  const user = currentUser(store, ctx);
  const rows = user ? store.listContacts(user.id) : [];
  const list = rows.map((row) => ({ userId: row.peerId, mutual: false }));
  const users = rows.map((row) => store.getUser(row.peerId)).filter(Boolean);
  return C.contacts({ list, users, savedCount: rows.length });
}

export default { getUsers, getFullUser, getContacts };
