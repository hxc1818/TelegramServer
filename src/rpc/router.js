// RPC method dispatch. Unwraps invokeWithLayer / initConnection and routes to
// the handler modules. Unknown methods answer with -501 NOT_IMPLEMENTED.
import { TLBuffer } from '../tl/buffer.js';
import * as C from './handlers/codecs.js';
import { isReader, skipInputClientProxy, skipJSONValue } from './handlers/parsers.js';
import * as help from './handlers/help.js';
import * as auth from './handlers/auth.js';
import * as users from './handlers/users.js';
import * as messages from './handlers/messages.js';
import * as updates from './handlers/updates.js';
import * as misc from './handlers/misc.js';

export const METHOD_IDS = Object.freeze({
  invokeWithLayer: 0xda9b0d0d,
  initConnection: 0xc1cd5ea9,
  invokeAfterMsg: 0xcb9f372d,
  invokeAfterMsgs: 0x3dc4b4f0,
  'help.getConfig': 0xc4f9186b,
  'help.getNearestDc': 0x1fb33026,
  'help.getAppUpdate': 0x522d5a7d,
  'auth.sendCode': 0xa677244f,
  'auth.signUp': 0xaac7b717,
  'auth.signIn': 0x8d52a951,
  'users.getUsers': 0xd91a548,
  'users.getFullUser': 0xb60f5918,
  'contacts.getContacts': 0x5dd69e12,
  'messages.getDialogs': 0xa0f4cb4f,
  'messages.getHistory': 0x4423e6c5,
  'messages.sendMessage': 0xfef48f62,
  'messages.readHistory': 0xe306d3a,
  'messages.getStickers': 0xd5a5d3a1,
  'updates.getState': 0xedd4882a,
  'updates.getDifference': 0x19c2f763,
  'upload.saveFilePart': 0xb304a621,
  'upload.getFile': 0xbe5335be,
  'account.updateStatus': 0x6628562c,
  'langpack.getLangPack': 0xf2f2330a,
  ping: 0x7abe77ec,
  pingDelayDisconnect: 0xf3427b8c,
});

const ID_TO_METHOD = Object.freeze(Object.fromEntries(
  Object.entries(METHOD_IDS).map(([name, id]) => [id >>> 0, name]),
));

const WRAPPERS = new Set(['invokeWithLayer', 'initConnection', 'invokeAfterMsg', 'invokeAfterMsgs']);

export function methodNameOf(value) {
  if (typeof value === 'number') return ID_TO_METHOD[value >>> 0] || null;
  if (typeof value === 'bigint') return ID_TO_METHOD[Number(value) >>> 0] || null;
  if (typeof value === 'string') {
    if (/^0x[0-9a-f]+$/i.test(value)) return ID_TO_METHOD[Number.parseInt(value, 16) >>> 0] || null;
    return value;
  }
  return null;
}

const HANDLERS = Object.freeze({
  'help.getConfig': help.getConfig,
  'help.getNearestDc': help.getNearestDc,
  'help.getAppUpdate': help.getAppUpdate,
  'auth.sendCode': auth.sendCode,
  'auth.signUp': auth.signUp,
  'auth.signIn': auth.signIn,
  'users.getUsers': users.getUsers,
  'users.getFullUser': users.getFullUser,
  'contacts.getContacts': users.getContacts,
  'messages.getDialogs': messages.getDialogs,
  'messages.getHistory': messages.getHistory,
  'messages.sendMessage': messages.sendMessage,
  'messages.readHistory': messages.readHistory,
  'messages.getStickers': misc.getStickers,
  'updates.getState': updates.getState,
  'updates.getDifference': updates.getDifference,
  'upload.saveFilePart': misc.saveFilePart,
  'upload.getFile': misc.getFile,
  'account.updateStatus': misc.updateStatus,
  'langpack.getLangPack': misc.getLangPack,
  ping: misc.ping,
  pingDelayDisconnect: misc.pingDelayDisconnect,
});

const SAFE_FALLBACK = Object.freeze({
  'help.getConfig': () => C.config({}),
  'help.getNearestDc': () => C.nearestDc({ country: 'US', thisDc: 1, nearestDc: 1 }),
  'help.getAppUpdate': () => C.noAppUpdate(),
  'updates.getState': () => C.state({}),
  'updates.getDifference': () => C.differenceEmpty({ date: 0, seq: 0 }),
  'messages.getDialogs': () => C.dialogsSlice({}),
  'messages.getHistory': () => C.messagesSlice({}),
  'messages.sendMessage': () => C.updateShortSentMessage({}),
  'messages.readHistory': () => C.affectedHistory({}),
  'account.updateStatus': () => C.boolTrue(),
  'messages.getStickers': () => C.stickers({}),
  'upload.saveFilePart': () => C.boolTrue(),
});

function asReader(params) {
  if (isReader(params)) return params;
  if (Buffer.isBuffer(params)) return new TLBuffer(params);
  if (Array.isArray(params) || params === undefined || params === null) return params;
  return params;
}

export class Router {
  constructor({ store, keys, config } = {}) {
    this.store = store;
    this.keys = keys;
    this.config = config;
  }

  supports(name) {
    const key = methodNameOf(name);
    return Boolean(key && (WRAPPERS.has(key) || Object.hasOwn(HANDLERS, key)));
  }

  handle(methodName, params, ctx = {}) {
    const name = methodNameOf(methodName);
    const r = asReader(params);
    const context = ctx && typeof ctx === 'object' ? ctx : {};
    if (!context.store) context.store = this.store;
    if (!context.keys) context.keys = this.keys;
    if (!context.config) context.config = this.config;
    if (!context.router) context.router = this;
    return this._dispatch(name, r, context);
  }

  _next(r, ctx) {
    if (!isReader(r)) {
      const inner = r?.query;
      const name = methodNameOf(inner);
      if (!name) return C.rpcError({ code: -501, message: 'NOT_IMPLEMENTED' });
      return this._dispatch(name, inner.params ?? inner, ctx);
    }
    if (!r.has(4)) return C.rpcError({ code: -501, message: 'NOT_IMPLEMENTED' });
    const id = r.uint();
    const name = ID_TO_METHOD[id >>> 0];
    if (!name) {
      if (ctx.config?.logTL) console.warn('[rpc] unknown constructor', `0x${(id >>> 0).toString(16)}`);
      return C.rpcError({ code: -501, message: 'NOT_IMPLEMENTED' });
    }
    return this._dispatch(name, r, ctx);
  }

  _dispatch(name, r, ctx) {
    if (!name) return C.rpcError({ code: -501, message: 'NOT_IMPLEMENTED' });

    if (name === 'invokeWithLayer') {
      if (isReader(r)) {
        if (r.has(4)) r.int(); // layer
      } else {
        if (r?.layer !== undefined) ctx.layer = Number(r.layer);
      }
      return this._next(r, ctx);
    }

    if (name === 'initConnection') {
      if (isReader(r)) {
        const flags = r.has(4) ? r.uint() : 0;
        if (r.has(4)) r.int(); // api_id
        for (let i = 0; i < 6; i++) if (r.has(1)) r.string(); // device/system/app/lang strings
        if (flags & 1) skipInputClientProxy(r);
        if (flags & 2) skipJSONValue(r);
        ctx.initConnection = true;
      } else if (r && typeof r === 'object') {
        ctx.initConnection = true;
      }
      return this._next(r, ctx);
    }

    if (name === 'invokeAfterMsg' || name === 'invokeAfterMsgs') {
      if (isReader(r)) {
        if (name === 'invokeAfterMsg') {
          if (r.has(8)) r.long();
        } else if (r.has(4)) {
          const n = r.int();
          for (let i = 0; i < n && r.has(8); i++) r.long();
        }
      }
      return this._next(r, ctx);
    }

    const handler = HANDLERS[name];
    if (!handler) return C.rpcError({ code: -501, message: 'NOT_IMPLEMENTED' });

    try {
      const result = handler(r, ctx, this);
      return Buffer.isBuffer(result) ? result : C.rpcError({ code: -501, message: 'NOT_IMPLEMENTED' });
    } catch (err) {
      if (ctx.config?.logTL) console.error('[rpc] handler failed', name, err);
      const fallback = SAFE_FALLBACK[name];
      if (fallback) return fallback();
      // Never surface a 5xx or FLOOD_WAIT for a startup RPC.
      return C.rpcError({ code: -501, message: 'NOT_IMPLEMENTED' });
    }
  }
}

export default Router;
