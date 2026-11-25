import * as C from './codecs.js';
import { int, long, str, isReader, readInputPeer, skipInputReplyTo } from './parsers.js';
import { authKeyIdOf, currentUser } from './context.js';

function peerId(peer, ctx, store) {
  if (peer.type === 'self') return currentUser(store, ctx)?.id || 0;
  return peer.id || 0;
}

function usersFromMessages(store, messages) {
  const ids = new Set(messages.map((m) => Number(m.fromId)).filter(Boolean));
  return [...ids].map((id) => store.getUser(id)).filter(Boolean);
}

export function getDialogs(r, ctx) {
  const store = ctx.store;
  if (isReader(r)) {
    const flags = r.int();
    if (flags & 1) r.int(); // exclude_pinned
    if (flags & 2) r.int(); // folder_id
    r.int(); // offset_date
    r.int(); // offset_id
    readInputPeer(r); // offset_peer
    r.int(); // limit
    r.long(); // hash
  }
  const user = currentUser(store, ctx);
  const dialogs = user ? store.listDialogs(user.id) : [];
  const messages = dialogs.map((d) => store.getMessage(d.topMessage)).filter(Boolean);
  const users = messages.length ? usersFromMessages(store, messages) : (user ? [user] : []);
  return C.dialogsSlice({ count: dialogs.length, dialogs, messages, users });
}

export function getHistory(r, ctx) {
  const store = ctx.store;
  let peer;
  let limit = 20;
  if (isReader(r)) {
    peer = readInputPeer(r);
    r.int(); // offset_id
    r.int(); // offset_date
    r.int(); // add_offset
    limit = r.int();
    r.int(); // max_id
    r.int(); // min_id
    r.long(); // hash
  } else {
    peer = readInputPeer(r, 'peer');
    limit = int(r, 'limit', 20);
  }
  const type = peer.type === 'self' ? 'user' : peer.type;
  const id = peerId(peer, ctx, store);
  const messages = store.listMessages(type, id, Math.min(Math.max(limit, 1), 100));
  return C.messagesSlice({
    count: messages.length,
    messages,
    users: usersFromMessages(store, messages),
  });
}

export function sendMessage(r, ctx) {
  const store = ctx.store;
  let peer;
  let text;
  let randomId;
  if (isReader(r)) {
    const flags = r.int();
    if (flags & 1) skipInputReplyTo(r);
    peer = readInputPeer(r);
    text = r.string();
    randomId = r.long();
  } else {
    peer = readInputPeer(r, 'peer');
    text = str(r, 'message', '');
    randomId = long(r, 'randomId', 0n);
  }
  const user = currentUser(store, ctx);
  const type = peer.type === 'self' ? 'user' : peer.type;
  const msg = store.putMessage({
    fromId: user?.id || 0,
    peerType: type,
    peerId: peerId(peer, ctx, store),
    text,
    randomId: Number(randomId),
  });
  const pts = store.nextPts(user?.id || 0, authKeyIdOf(ctx));
  return C.updateShortSentMessage({ out: true, id: msg.id, pts, ptsCount: 1, date: msg.date });
}

export function readHistory(r, ctx) {
  const store = ctx.store;
  const peer = isReader(r) ? readInputPeer(r) : readInputPeer(r, 'peer');
  const maxId = isReader(r) ? r.int() : int(r, 'maxId', 0);
  const id = peerId(peer, ctx, store);
  store.markRead(peer.type, id, maxId);
  const user = currentUser(store, ctx);
  const pts = store.nextPts(user?.id || 0, authKeyIdOf(ctx));
  return C.affectedHistory({ pts, ptsCount: 1, offset: 0 });
}

export default { getDialogs, getHistory, sendMessage, readHistory };
