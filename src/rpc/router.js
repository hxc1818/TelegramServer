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
import * as media from './handlers/media.js';
import * as extra from './handlers/messaging-extra.js';
import * as groups from './handlers/groups.js';
import * as accountHandlers from './handlers/account.js';
import * as foldersHandlers from './handlers/folders.js';
import * as stickersHandlers from './handlers/stickers.js';
import * as botsHandlers from './handlers/bots.js';
import * as helpExtra from './handlers/help-extra.js';
import * as twoFA from './handlers/twofa.js';
import * as secret from './handlers/secret.js';
import * as callsHandlers from './handlers/calls.js';
import * as storiesHandlers from './handlers/stories.js';

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
  'upload.saveBigFilePart': 0xde7b673d,
  'upload.getFile': 0xbe5335be,
  'messages.sendMedia': 0x330e77f,
  'messages.getDocumentByHash': 0xb1f2061f,
  'messages.getWebPage': 0x8d9692a3,
  'account.updateStatus': 0x6628562c,
  'langpack.getLangPack': 0xf2f2330a,
  ping: 0x7abe77ec,
  pingDelayDisconnect: 0xf3427b8c,
  ...extra.METHOD_IDS,
  'messages.createChat': 0x92ceddd4,
  'messages.addChatUser': 0xcbc6d107,
  'messages.getChats': 0x49e9528f,
  'messages.getFullChat': 0xaeb00b34,
  'messages.editChatTitle': 0x73783ffd,
  'messages.getMessages': 0x63c66506,
  'channels.createChannel': 0x91006707,
  'channels.inviteToChannel': 0xc9e33d54,
  'channels.getChannels': 0xa7f6bbb,
  'channels.getFullChannel': 0x8736a09,
  'channels.editTitle': 0x566decd0,
  'channels.getMessages': 0xad8c9a23,
  ...accountHandlers.METHOD_IDS,
  'messages.toggleDialogPin': 0xa731e257,
  'messages.getPinnedDialogs': 0xd6b94df2,
  'folders.editPeerFolders': 0x6847d0ab,
  'chatlists.getChatlistUpdates': 0x89419521,
  ...stickersHandlers.METHOD_ID,
  ...botsHandlers.METHOD_IDS,
  ...helpExtra.METHOD_IDS,
  ...twoFA.METHOD_IDS,
  ...secret.METHOD_IDS,
  ...callsHandlers.METHOD_IDS,
  ...storiesHandlers.METHOD_IDS,
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
  'upload.saveFilePart': media.saveFilePart,
  'upload.saveBigFilePart': media.saveBigFilePart,
  'upload.getFile': media.getFile,
  'messages.sendMedia': media.sendMedia,
  'messages.getDocumentByHash': media.getDocumentByHash,
  'messages.getWebPage': media.getWebPage,
  'account.updateStatus': misc.updateStatus,
  'langpack.getLangPack': misc.getLangPack,
  ping: misc.ping,
  pingDelayDisconnect: misc.pingDelayDisconnect,
  'messages.editMessage': extra.editMessage,
  'messages.deleteMessages': extra.deleteMessages,
  'messages.forwardMessages': extra.forwardMessages,
  'messages.search': extra.search,
  'messages.searchGlobal': extra.searchGlobal,
  'messages.saveDraft': extra.saveDraft,
  'messages.getAllDrafts': extra.getAllDrafts,
  'messages.clearAllDrafts': extra.clearAllDrafts,
  'messages.readMentions': extra.readMentions,
  'messages.readReactions': extra.readReactions,
  'messages.sendReaction': extra.sendReaction,
  'messages.sendScreenshotNotification': extra.sendScreenshotNotification,
  'updates.getChannelDifference': extra.getChannelDifference,
  'messages.createChat': groups.createChat,
  'messages.addChatUser': groups.addChatUser,
  'messages.getChats': groups.getChats,
  'messages.getFullChat': groups.getFullChat,
  'messages.editChatTitle': groups.editChatTitle,
  'messages.getMessages': groups.getMessages,
  'channels.createChannel': groups.createChannel,
  'channels.inviteToChannel': groups.inviteToChannel,
  'channels.getChannels': groups.getChannels,
  'channels.getFullChannel': groups.getFullChannel,
  'channels.editTitle': groups.editTitle,
  'channels.getMessages': groups.getMessages,
  'account.updateProfile': accountHandlers.updateProfile,
  'account.updateUsername': accountHandlers.updateUsername,
  'account.setStatus': accountHandlers.setStatus,
  'account.updateStatus': accountHandlers.setStatus,
  'account.getPrivacy': accountHandlers.getPrivacy,
  'account.setPrivacy': accountHandlers.setPrivacy,
  'account.getNotifySettings': accountHandlers.getNotifySettings,
  'account.updateNotifySettings': accountHandlers.updateNotifySettings,
  'account.getWallPapers': accountHandlers.getWallPapers,
  'account.getThemes': accountHandlers.getThemes,
  'contacts.addContact': accountHandlers.addContact,
  'contacts.deleteContacts': accountHandlers.deleteContacts,
  'contacts.importContacts': accountHandlers.importContacts,
  'contacts.block': accountHandlers.block,
  'contacts.unblock': accountHandlers.unblock,
  'contacts.getBlocked': accountHandlers.getBlocked,
  'auth.exportAuthorization': accountHandlers.exportAuthorization,
  'auth.importAuthorization': accountHandlers.importAuthorization,
  'messages.toggleDialogPin': foldersHandlers.toggleDialogPin,
  'messages.getPinnedDialogs': foldersHandlers.getPinnedDialogs,
  'folders.editPeerFolders': foldersHandlers.editPeerFolders,
  'chatlists.getChatlistUpdates': foldersHandlers.getChatlistUpdates,
  'messages.getStickers': stickersHandlers.getStickers,
  'messages.getFeaturedStickers': stickersHandlers.getFeaturedStickers,
  'messages.getStickerSet': stickersHandlers.getStickerSet,
  'messages.getSavedGifs': stickersHandlers.getSavedGifs,
  'messages.saveGif': stickersHandlers.saveGif,
  'messages.getAttachedStickers': stickersHandlers.getAttachedStickers,
  'stickers.createStickerSet': stickersHandlers.createStickerSet,
  'stickers.addStickerToSet': stickersHandlers.addStickerToSet,
  'stickers.removeStickerFromSet': stickersHandlers.removeStickerFromSet,
  'messages.getInlineBotResults': botsHandlers.getInlineBotResults,
  'messages.sendInlineBotResult': botsHandlers.sendInlineBotResult,
  'messages.setGameScore': botsHandlers.setGameScore,
  'messages.getGameHighScores': botsHandlers.getGameHighScores,
  'messages.getScheduledMessages': botsHandlers.getScheduledMessages,
  'messages.sendScheduledMessages': botsHandlers.sendScheduledMessages,
  'messages.deleteScheduledMessages': botsHandlers.deleteScheduledMessages,
  'bots.getBotInfo': botsHandlers.getBotInfo,
  'bots.setBotInfo': botsHandlers.setBotInfo,
  'bots.canSendMessage': botsHandlers.canSendMessage,
  'bots.checkUsername': botsHandlers.checkUsername,
  'bots.getBotCommands': botsHandlers.getBotCommands,
  'bots.setBotCommands': botsHandlers.setBotCommands,
  'bots.getBotMenuButton': botsHandlers.getBotMenuButton,
  'bots.getAdminedBots': botsHandlers.getAdminedBots,
  'help.getCdnConfig': helpExtra.getCdnConfig,
  'help.getInviteText': helpExtra.getInviteText,
  'help.getSupport': helpExtra.getSupport,
  'help.getTermsOfServiceUpdate': helpExtra.getTermsOfServiceUpdate,
  'help.getCountriesList': helpExtra.getCountriesList,
  'help.getAppUpdate': helpExtra.getAppUpdate,
  'help.getPromoData': helpExtra.getPromoData,
  'help.getPassportConfig': helpExtra.getPassportConfig,
  'langpack.getLanguages': helpExtra.getLanguages,
  'langpack.getLanguage': helpExtra.getLanguage,
  'langpack.getStrings': helpExtra.getStrings,
  'langpack.getDifference': helpExtra.getDifference,
  'langpack.getLangPack': helpExtra.getLangPack,
  'account.getPassword': twoFA.getPassword,
  'account.updatePasswordSettings': twoFA.updatePasswordSettings,
  'account.getPasswordSettings': twoFA.getPasswordSettings,
  'account.deleteAccount': twoFA.deleteAccount,
  'auth.checkPassword': twoFA.checkPassword,
  'auth.resendCode': twoFA.resendCode,
  'auth.signUp': twoFA.signUp,
  'auth.exportLoginToken': twoFA.exportLoginToken,
  'auth.importLoginToken': twoFA.importLoginToken,
  'auth.acceptLoginToken': twoFA.acceptLoginToken,
  'messages.requestEncryption': secret.requestEncryption,
  'messages.acceptEncryption': secret.acceptEncryption,
  'messages.discardEncryption': secret.discardEncryption,
  'messages.setEncryptedTyping': secret.setEncryptedTyping,
  'messages.readEncryptedHistory': secret.readEncryptedHistory,
  'messages.sendEncrypted': secret.sendEncrypted,
  'messages.sendEncryptedFile': secret.sendEncryptedFile,
  'messages.sendEncryptedService': secret.sendEncryptedService,
  'messages.reportEncryptedSpam': secret.reportEncryptedSpam,
  'messages.uploadEncryptedFile': secret.uploadEncryptedFile,
  'phone.getCallConfig': callsHandlers.getCallConfig,
  'phone.requestCall': callsHandlers.requestCall,
  'phone.acceptCall': callsHandlers.acceptCall,
  'phone.confirmCall': callsHandlers.confirmCall,
  'phone.receivedCall': callsHandlers.receivedCall,
  'phone.discardCall': callsHandlers.discardCall,
  'phone.setCallRating': callsHandlers.setCallRating,
  'phone.saveCallDebug': callsHandlers.saveCallDebug,
  'phone.sendSignalingData': callsHandlers.sendSignalingData,
  'phone.saveCallLog': callsHandlers.saveCallLog,
  'stories.canSendStory': storiesHandlers.canSendStory,
  'stories.sendStory': storiesHandlers.sendStory,
  'stories.deleteStories': storiesHandlers.deleteStories,
  'stories.getPinnedStories': storiesHandlers.getPinnedStories,
  'stories.getStoriesArchive': storiesHandlers.getStoriesArchive,
  'stories.getStoriesByID': storiesHandlers.getStoriesByID,
  'stories.getPeerStories': storiesHandlers.getPeerStories,
  'stories.readStories': storiesHandlers.readStories,
  'stories.incrementStoryViews': storiesHandlers.incrementStoryViews,
  'stories.getStoryViewsList': storiesHandlers.getStoryViewsList,
  'stories.getStoriesViews': storiesHandlers.getStoriesViews,
  'account.registerDevice': storiesHandlers.registerDevice,
  'account.unregisterDevice': storiesHandlers.unregisterDevice,
  'account.getPushSettings': storiesHandlers.getPushSettings,
  'account.updatePushSettings': storiesHandlers.updatePushSettings,
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
