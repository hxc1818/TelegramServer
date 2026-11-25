// Extra help.* / langpack.* RPC handlers for layer 234.
//
// Every constructor/method id below was grep-verified against the pinned
// schema/api.tl. Codecs are local so no existing handler or router file has to
// change. Every handler accepts a TLBuffer positioned after the request
// constructor id or a plain JS object.
//
// Two names in the task list do not exist in layer 234:
//   help.getTermsOfService -> use help.getTermsOfServiceUpdate (0x2ca51fd1)
//   help.getProxyData / help.getPromoInfo -> use help.getPromoData (0xc0977421)
// They are exported as aliases, with the closest schema-declared response.

import { TLBuffer } from '../../tl/buffer.js';
import { HelpStore } from '../../store/help.js';
import { int, isReader, str } from './parsers.js';

export const ID = Object.freeze({
  vector: 0x1cb5c415,                        // vector#1cb5c415
  boolTrue: 0x997275b5,                      // boolTrue#997275b5
  peerUser: 0x59511722,                      // peerUser#59511722
  peerChat: 0x36c6019a,                      // peerChat#36c6019a
  peerChannel: 0xa2a5371e,                   // peerChannel#a2a5371e
  userEmpty: 0xd3bc4b7a,                     // userEmpty#d3bc4b7a
  chatEmpty: 0x29562865,                     // chatEmpty#29562865
  dataJSON: 0x7d748d04,                      // dataJSON#7d748d04
  cdnPublicKey: 0xc982eaba,                  // cdnPublicKey#c982eaba
  cdnConfig: 0x5725e40a,                     // cdnConfig#5725e40a
  inviteText: 0x18cb9f78,                    // help.inviteText#18cb9f78
  support: 0x17c6b5f6,                       // help.support#17c6b5f6
  termsOfService: 0x780a0310,                // help.termsOfService#780a0310
  termsOfServiceUpdate: 0x28ecf961,          // help.termsOfServiceUpdate#28ecf961
  termsOfServiceUpdateEmpty: 0xe3309f7f,     // help.termsOfServiceUpdateEmpty#e3309f7f
  countriesList: 0x87d0759e,                 // help.countriesList#87d0759e
  countriesListNotModified: 0x93cc1f32,      // help.countriesListNotModified#93cc1f32
  country: 0xc3878e23,                       // help.country#c3878e23
  countryCode: 0x4203c5ef,                   // help.countryCode#4203c5ef
  appUpdate: 0xccbbce30,                     // help.appUpdate#ccbbce30
  noAppUpdate: 0xc45a6536,                   // help.noAppUpdate#c45a6536
  promoData: 0x8a4d87a,                      // help.promoData#8a4d87a
  promoDataEmpty: 0x98f6ac75,                // help.promoDataEmpty#98f6ac75
  pendingSuggestion: 0xe7e82e12,             // pendingSuggestion#e7e82e12
  textWithEntities: 0x751f3146,              // textWithEntities#751f3146
  passportConfig: 0xa098d6af,                // help.passportConfig#a098d6af
  passportConfigNotModified: 0xbfb9f457,     // help.passportConfigNotModified#bfb9f457
  langPackLanguage: 0xeeca5ce3,              // langPackLanguage#eeca5ce3
  langPackString: 0xcad181f6,                // langPackString#cad181f6
  langPackStringDeleted: 0x2979eeb2,         // langPackStringDeleted#2979eeb2
  langPackDifference: 0xf385c1f6,            // langPackDifference#f385c1f6
});

const ENTITY_ID = Object.freeze({
  unknown: 0xbb92ba95,
  mention: 0xfa04579d,
  hashtag: 0x6f635b0d,
  botCommand: 0x6cef8ac7,
  url: 0x6ed02538,
  email: 0x64e475c2,
  bold: 0xbd610bc9,
  italic: 0x826f8b60,
  code: 0x28a20571,
  pre: 0x73924be0,
  textUrl: 0x76a6d327,
  mentionName: 0xdc7b1140,
  phone: 0x9b69e34b,
  cashtag: 0x4c4e743f,
  underline: 0x9c4e7e8b,
  strike: 0xbf0693d4,
  bankCard: 0x761e6af4,
  spoiler: 0x32ca960f,
  customEmoji: 0xc8cf05f8,
});

/** Enumerated ids map 1:1 to schema/api.tl functions. */
const METHOD_ID_TABLE = {
  'help.getCdnConfig': 0x52029342,            // #52029342
  'help.getInviteText': 0x4d392343,          // #4d392343
  'help.getSupport': 0x9cdf08cd,             // #9cdf08cd
  'help.getTermsOfServiceUpdate': 0x2ca51fd1, // #2ca51fd1
  'help.getCountriesList': 0x735787a8,       // #735787a8
  'help.getAppUpdate': 0x522d5a7d,           // #522d5a7d
  'help.getPromoData': 0xc0977421,           // #c0977421
  'help.getPassportConfig': 0xc661ad08,      // #c661ad08
  'langpack.getLanguages': 0x42c6978f,       // #42c6978f
  'langpack.getLanguage': 0x6a596502,        // #6a596502
  'langpack.getStrings': 0xefea3803,         // #efea3803
  'langpack.getDifference': 0xcd984aa5,      // #cd984aa5
  'langpack.getLangPack': 0xf2f2330a,        // #f2f2330a
};

/** Aliases for names that are not actual layer-234 methods. */
export const METHOD_ALIASES = Object.freeze({
  'help.getTermsOfService': 'help.getTermsOfServiceUpdate',
  'help.getProxyData': 'help.getPromoData',
  'help.getPromoInfo': 'help.getPromoData',
});

// Aliases are reachable by name but not enumerated, so a schema verification
// loop over Object.entries(METHOD_IDS) only sees real layer-234 functions.
for (const [alias, canonical] of Object.entries(METHOD_ALIASES)) {
  Object.defineProperty(METHOD_ID_TABLE, alias, {
    value: METHOD_ID_TABLE[canonical], enumerable: false,
  });
}
export const METHOD_IDS = Object.freeze(METHOD_ID_TABLE);

const i32 = (v) => Number(v) | 0;

function toBig(value) {
  if (value === undefined || value === null) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  const text = String(value);
  return /^-?\d+$/.test(text) ? BigInt(text) : 0n;
}

function helpStoreOf(ctx = {}) {
  if (ctx.helpStore && typeof ctx.helpStore.getInviteText === 'function') return ctx.helpStore;
  if (ctx.store && typeof ctx.store.getInviteText === 'function') return ctx.store;
  const dataDir = ctx.dataDir || ctx.store?.dataDir || ctx.config?.dataDir || './data';
  ctx.helpStore = new HelpStore(dataDir);
  return ctx.helpStore;
}

function hashOf(parts) {
  let h = 0x811c9dc5;
  const text = parts.map((p) => String(p)).join('\u0000');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---- local TL encoders -------------------------------------------------

function putPeer(peer, b) {
  if (Buffer.isBuffer(peer)) {
    b.putRaw(peer);
    return;
  }
  const type = peer?.type || peer?.peerType || 'user';
  const id = toBig(peer?.id ?? peer?.peerId ?? 0);
  if (type === 'chat') b.putUint(ID.peerChat).putLong(id);
  else if (type === 'channel') b.putUint(ID.peerChannel).putLong(id);
  else b.putUint(ID.peerUser).putLong(id);
}

function encodeCountryCode(code, b) {
  const prefixes = Array.isArray(code?.prefixes) ? code.prefixes : [];
  const patterns = Array.isArray(code?.patterns) ? code.patterns : [];
  const flags = (prefixes.length ? 1 : 0) | (patterns.length ? 2 : 0);
  b.putUint(ID.countryCode).putUint(flags).putString(String(code?.countryCode ?? ''));
  if (flags & 1) b.putVector(prefixes, (p, bb) => bb.putString(String(p)));
  if (flags & 2) b.putVector(patterns, (p, bb) => bb.putString(String(p)));
}

function encodeCountry(country, b) {
  const codes = Array.isArray(country?.countryCodes) ? country.countryCodes : [];
  const name = country?.name ? String(country.name) : '';
  const flags = (country?.hidden ? 1 : 0) | (name ? 2 : 0);
  b.putUint(ID.country).putUint(flags);
  if (flags & 1) b.putUint(ID.boolTrue);
  b.putString(String(country?.iso2 ?? '')).putString(String(country?.defaultName ?? ''));
  if (flags & 2) b.putString(name);
  b.putVector(codes, encodeCountryCode);
}

function encodeEntity(entity = {}, b) {
  const type = String(entity.type ?? 'unknown');
  const id = Number.isFinite(Number(entity.id)) && entity.id !== undefined ? Number(entity.id) >>> 0 : (ENTITY_ID[type] ?? ENTITY_ID.unknown);
  const offset = i32(entity.offset ?? 0);
  const length = i32(entity.length ?? 0);
  b.putUint(id).putInt(offset).putInt(length);
  if (id === ENTITY_ID.pre) b.putString(String(entity.language ?? ''));
  else if (id === ENTITY_ID.textUrl) b.putString(String(entity.url ?? ''));
  else if (id === ENTITY_ID.mentionName || id === ENTITY_ID.customEmoji) {
    b.putLong(toBig(entity.userId ?? entity.documentId ?? 0));
  }
}

function encodeTerms(terms = {}, b) {
  const popup = Boolean(terms.popup);
  const hasMinAge = terms.minAgeConfirm !== undefined && terms.minAgeConfirm !== null;
  const flags = (popup ? 1 : 0) | (hasMinAge ? 2 : 0);
  const entities = Array.isArray(terms.entities) ? terms.entities : [];
  b.putUint(ID.termsOfService).putUint(flags);
  if (flags & 1) b.putUint(ID.boolTrue);
  b.putUint(ID.dataJSON).putString(typeof terms.id === 'string' ? terms.id : JSON.stringify(terms.id ?? ''));
  b.putString(String(terms.text ?? ''));
  b.putVector(entities, encodeEntity);
  if (flags & 2) b.putInt(i32(terms.minAgeConfirm));
}

function encodeTextWithEntities(value, b) {
  const text = typeof value === 'string' ? value : String(value?.text ?? '');
  const entities = Array.isArray(value?.entities) ? value.entities : [];
  b.putUint(ID.textWithEntities).putString(text).putVector(entities, encodeEntity);
}

function encodeLangPackString(item = {}, b) {
  if (item.deleted) {
    b.putUint(ID.langPackStringDeleted).putString(String(item.key ?? ''));
  } else {
    b.putUint(ID.langPackString).putString(String(item.key ?? '')).putString(String(item.value ?? ''));
  }
}

function encodeLanguage(language = {}, b) {
  const baseLangCode = String(language.baseLangCode ?? '');
  const flags = (language.official ? 1 : 0)
    | (baseLangCode ? 2 : 0)
    | (language.rtl ? 4 : 0)
    | (language.beta ? 8 : 0);
  b.putUint(ID.langPackLanguage).putUint(flags);
  if (flags & 1) b.putUint(ID.boolTrue);
  if (flags & 4) b.putUint(ID.boolTrue);
  if (flags & 8) b.putUint(ID.boolTrue);
  b.putString(String(language.name ?? ''))
    .putString(String(language.nativeName ?? ''))
    .putString(String(language.langCode ?? ''));
  if (flags & 2) b.putString(baseLangCode);
  b.putString(String(language.pluralCode ?? ''))
    .putInt(i32(language.stringsCount ?? 0))
    .putInt(i32(language.translatedCount ?? 0))
    .putString(String(language.translationsUrl ?? ''));
}

function encodeDifference(diff = {}) {
  const strings = Array.isArray(diff.strings) ? diff.strings : [];
  return new TLBuffer()
    .putUint(ID.langPackDifference)
    .putString(String(diff.langCode ?? 'en'))
    .putInt(i32(diff.fromVersion ?? 0))
    .putInt(i32(diff.version ?? 0))
    .putVector(strings, encodeLangPackString)
    .buffer;
}

// ---- help.* handlers ---------------------------------------------------

export function getCdnConfig(params, ctx) {
  const help = helpStoreOf(ctx);
  const config = help.getCdnConfig();
  const keys = Array.isArray(config.publicKeys) ? config.publicKeys : [];
  return new TLBuffer()
    .putUint(ID.cdnConfig)
    .putVector(keys, (k, b) => b.putUint(ID.cdnPublicKey)
      .putInt(i32(k?.dcId ?? k?.dc_id ?? 0))
      .putString(String(k?.publicKey ?? k?.public_key ?? '')))
    .buffer;
}

export function getInviteText(params, ctx) {
  const help = helpStoreOf(ctx);
  return new TLBuffer().putUint(ID.inviteText).putString(help.getInviteText()).buffer;
}

export function getSupport(params, ctx) {
  const help = helpStoreOf(ctx);
  const support = help.getSupport();
  return new TLBuffer()
    .putUint(ID.support)
    .putString(String(support.phoneNumber ?? ''))
    .putUint(ID.userEmpty)
    .putLong(toBig(support.userId ?? 0))
    .buffer;
}

export function getTermsOfServiceUpdate(params, ctx) {
  const help = helpStoreOf(ctx);
  const terms = help.getTerms() || {};
  if (!terms.text) {
    return new TLBuffer().putUint(ID.termsOfServiceUpdateEmpty).putInt(i32(terms.expires ?? 0)).buffer;
  }
  const encoded = new TLBuffer();
  encodeTerms(terms, encoded);
  return new TLBuffer()
    .putUint(ID.termsOfServiceUpdate)
    .putInt(i32(terms.expires ?? 0))
    .putRaw(encoded.buffer)
    .buffer;
}

/** Alias: layer 234 has no help.getTermsOfService method. */
export const getTermsOfService = getTermsOfServiceUpdate;

export function getCountriesList(params, ctx) {
  const help = helpStoreOf(ctx);
  const hash = i32(int(params, 'hash', 0));
  const countries = help.listCountries();
  const currentHash = hashOf(countries.map((c) => c.iso2));
  if (hash !== 0 && hash === currentHash) {
    return new TLBuffer().putUint(ID.countriesListNotModified).buffer;
  }
  return new TLBuffer()
    .putUint(ID.countriesList)
    .putVector(countries, encodeCountry)
    .putInt(i32(currentHash))
    .buffer;
}

export function getAppUpdate(params, ctx) {
  str(params, 'source', ''); // ignored: this server offers no automatic update
  const help = helpStoreOf(ctx);
  const update = help.getAppUpdate();
  if (!update || typeof update !== 'object') {
    return new TLBuffer().putUint(ID.noAppUpdate).buffer;
  }
  const hasDocument = Buffer.isBuffer(update.document);
  const hasSticker = Buffer.isBuffer(update.sticker);
  const hasUrl = update.url !== undefined && update.url !== null;
  const flags = (update.canNotSkip ? 1 : 0)
    | (hasDocument ? 2 : 0)
    | (hasUrl ? 4 : 0)
    | (hasSticker ? 8 : 0);
  const entities = Array.isArray(update.entities) ? update.entities : [];
  const b = new TLBuffer().putUint(ID.appUpdate).putUint(flags);
  if (flags & 1) b.putUint(ID.boolTrue);
  b.putInt(i32(update.id ?? 0)).putString(String(update.version ?? '')).putString(String(update.text ?? ''));
  b.putVector(entities, encodeEntity);
  if (flags & 2) b.putRaw(update.document);
  if (flags & 4) b.putString(String(update.url));
  if (flags & 8) b.putRaw(update.sticker);
  return b.buffer;
}

export function getPromoData(params, ctx) {
  const help = helpStoreOf(ctx);
  const expires = i32(Number(help.getConfigOverride('promoExpires') ?? 0));
  const promo = help.getConfigOverride('promoData');
  if (!promo || typeof promo !== 'object') {
    return new TLBuffer().putUint(ID.promoDataEmpty).putInt(expires).buffer;
  }
  const pending = Array.isArray(promo.pendingSuggestions) ? promo.pendingSuggestions : [];
  const dismissed = Array.isArray(promo.dismissedSuggestions) ? promo.dismissedSuggestions : [];
  const chats = Array.isArray(promo.chats) ? promo.chats : [];
  const users = Array.isArray(promo.users) ? promo.users : [];
  const hasPeer = promo.peer !== undefined && promo.peer !== null;
  const hasPsaType = promo.psaType !== undefined && promo.psaType !== null;
  const hasPsaMessage = promo.psaMessage !== undefined && promo.psaMessage !== null;
  const hasCustom = promo.customPendingSuggestion !== undefined && promo.customPendingSuggestion !== null;
  const flags = (promo.proxy ? 1 : 0)
    | (hasPsaType ? 2 : 0)
    | (hasPsaMessage ? 4 : 0)
    | (hasPeer ? 8 : 0)
    | (hasCustom ? 16 : 0);
  const b = new TLBuffer().putUint(ID.promoData).putUint(flags);
  if (flags & 1) b.putUint(ID.boolTrue);
  b.putInt(expires);
  if (flags & 8) putPeer(promo.peer, b);
  if (flags & 2) b.putString(String(promo.psaType));
  if (flags & 4) b.putString(String(promo.psaMessage));
  b.putVector(pending, (s, bb) => bb.putString(String(s)));
  b.putVector(dismissed, (s, bb) => bb.putString(String(s)));
  if (flags & 16) {
    if (Buffer.isBuffer(promo.customPendingSuggestion)) b.putRaw(promo.customPendingSuggestion);
    else {
      const suggestion = promo.customPendingSuggestion;
      b.putUint(ID.pendingSuggestion).putString(String(suggestion.suggestion ?? ''));
      encodeTextWithEntities(suggestion.title ?? '', b);
      encodeTextWithEntities(suggestion.description ?? '', b);
      b.putString(String(suggestion.url ?? ''));
    }
  }
  b.putVector(chats, (c, bb) => bb.putRaw(Buffer.isBuffer(c) ? c : new TLBuffer().putUint(ID.chatEmpty).putLong(toBig(c?.id ?? 0)).buffer));
  b.putVector(users, (u, bb) => bb.putRaw(Buffer.isBuffer(u) ? u : new TLBuffer().putUint(ID.userEmpty).putLong(toBig(u?.id ?? 0)).buffer));
  return b.buffer;
}

/** Alias: layer 234 has no help.getProxyData / help.getPromoInfo method. */
export const getProxyData = getPromoData;
export const getPromoInfo = getPromoData;

export function getPassportConfig(params, ctx) {
  const help = helpStoreOf(ctx);
  const hash = i32(int(params, 'hash', 0));
  const currentHash = i32(Number(help.getConfigOverride('passportHash') ?? 0));
  if (hash !== 0 && hash === currentHash) {
    return new TLBuffer().putUint(ID.passportConfigNotModified).buffer;
  }
  const langs = help.getConfigOverride('passportCountriesLangs') ?? '{}';
  return new TLBuffer()
    .putUint(ID.passportConfig)
    .putInt(currentHash)
    .putUint(ID.dataJSON)
    .putString(typeof langs === 'string' ? langs : JSON.stringify(langs))
    .buffer;
}

// ---- langpack.* handlers -----------------------------------------------

export function getLanguages(params, ctx) {
  const help = helpStoreOf(ctx);
  str(params, 'langPack', '');
  return new TLBuffer()
    .putVector(help.getLanguages(), encodeLanguage)
    .buffer;
}

export function getLanguage(params, ctx) {
  const help = helpStoreOf(ctx);
  str(params, 'langPack', '');
  const langCode = str(params, 'langCode', '');
  const language = help.getLanguage(langCode) || {
    langCode, name: '', nativeName: '', baseLangCode: '', pluralCode: '',
    official: false, rtl: false, beta: false, stringsCount: 0,
    translatedCount: 0, translationsUrl: '', version: 0,
  };
  const b = new TLBuffer();
  encodeLanguage(language, b);
  return b.buffer;
}

export function getStrings(params, ctx) {
  const help = helpStoreOf(ctx);
  str(params, 'langPack', '');
  const langCode = str(params, 'langCode', '');
  const keys = isReader(params)
    ? (params.has(4) ? params.vector((r) => r.string()) : [])
    : (Array.isArray(params?.keys) ? params.keys : []);
  const strings = help.getStrings(langCode, keys);
  return new TLBuffer().putVector(strings, encodeLangPackString).buffer;
}

export function getDifference(params, ctx) {
  const help = helpStoreOf(ctx);
  str(params, 'langPack', '');
  const langCode = str(params, 'langCode', '');
  const fromVersion = int(params, 'fromVersion', 0);
  return encodeDifference(help.getDifference(langCode, fromVersion));
}

/** Typed replacement for misc.getLangPack (which always returns an empty pack). */
export function getLangPack(params, ctx) {
  const help = helpStoreOf(ctx);
  str(params, 'langPack', '');
  const langCode = str(params, 'langCode', '');
  return encodeDifference(help.getDifference(langCode, 0));
}

export default {
  getCdnConfig, getInviteText, getSupport, getTermsOfService,
  getTermsOfServiceUpdate, getCountriesList, getAppUpdate, getPromoData,
  getProxyData, getPromoInfo, getPassportConfig,
  getLanguages, getLanguage, getStrings, getDifference, getLangPack,
  ID, METHOD_IDS,
};
