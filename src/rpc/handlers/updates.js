import * as C from './codecs.js';
import { int, isReader } from './parsers.js';
import { currentUser } from './context.js';

export function getState(r, ctx) {
  const state = ctx.store.getState(currentUser(ctx.store, ctx)?.id || 0);
  return C.state({ ...state, unreadCount: state.unread_count });
}

export function getDifference(r, ctx) {
  if (isReader(r)) {
    const flags = r.int();
    r.int(); // pts
    if (flags & (1 << 1)) r.int(); // pts_limit
    if (flags & 1) r.int(); // pts_total_limit
    r.int(); // date
    r.int(); // qts
    if (flags & (1 << 2)) r.int(); // qts_limit
  }
  const state = ctx.store.getState(currentUser(ctx.store, ctx)?.id || 0);
  // differenceEmpty only carries date/seq; echo the persisted values so the
  // client never sees a gap between its pts and our state.
  return C.differenceEmpty({ date: state.date, seq: state.seq });
}

export default { getState, getDifference };
