// Payments / Stars / boosts RPC handlers for layer 234. Every constructor and
// method id below was grep-verified against the pinned schema/api.tl; the
// source line is recorded next to each entry. Results use local TLBuffer
// encoders that follow the declared field order and flags of each type.
//
// Note: in layer 234 the boost RPCs are premium.* methods (e.g.
// premium.getBoostsList#60f67660), not payments.* — METHOD_IDS uses the schema
// names. Every handler accepts a TLBuffer positioned after the request id (the
// form the Router supplies) or a plain parameter object (unit tests / program-
// matic dispatch).

import { TLBuffer } from '../../tl/buffer.js';
import { isReader, readInputPeer, readInputUser, skipJSONValue } from './parsers.js';
import { PaymentStore } from '../../store/payments.js';

/** Verified layer-234 constructor ids used by this module. */
export const PAYMENTS_ID = Object.freeze({
  boolTrue: 0x997275b5,                          // boolTrue#997275b5 (line 2)
  vector: 0x1cb5c415,                            // vector#1cb5c415 (line 6)
  documentEmpty: 0x36f8c871,                     // documentEmpty#36f8c871 (line 568)
  dataJSON: 0x7d748d04,                          // dataJSON#7d748d04 (line 1007)
  labeledPrice: 0xcb296bf8,                      // labeledPrice#cb296bf8 (line 1009)
  invoice: 0x49ee584,                            // invoice#49ee584 (line 1011)
  paymentCharge: 0xea02c27e,                     // paymentCharge#ea02c27e (line 1013)
  paymentRequestedInfo: 0x909c3f94,              // paymentRequestedInfo#909c3f94 (line 1017)
  paymentForm: 0xa0058751,                       // payments.paymentForm#a0058751 (line 1032)
  validatedRequestedInfo: 0xd1451883,           // payments.validatedRequestedInfo#d1451883 (line 1036)
  paymentResult: 0x4e5f810d,                     // payments.paymentResult#4e5f810d (line 1038)
  paymentReceipt: 0x70c4fe03,                    // payments.paymentReceipt#70c4fe03 (line 1041)
  savedInfo: 0xfb8fe43c,                         // payments.savedInfo#fb8fe43c (line 1044)
  shippingOption: 0xb6213cdf,                    // shippingOption#b6213cdf (line 1053)
  bankCardOpenUrl: 0xf568028a,                   // bankCardOpenUrl#f568028a (line 1390)
  bankCardData: 0x3e24e573,                      // payments.bankCardData#3e24e573 (line 1392)
  exportedInvoice: 0xaed0cbd9,                   // payments.exportedInvoice#aed0cbd9 (line 1612)
  updates: 0x74ae4240,                           // updates#74ae4240 (line 518)
  premiumGiftCodeOption: 0x257e962b,            // premiumGiftCodeOption#257e962b (line 1785)
  boost: 0x4b3e14d6,                             // boost#4b3e14d6 (line 1795)
  boostsList: 0x86f8613c,                        // premium.boostsList#86f8613c (line 1797)
  myBoost: 0xc448415c,                           // myBoost#c448415c (line 1799)
  myBoosts: 0x9ae228e2,                          // premium.myBoosts#9ae228e2 (line 1801)
  boostsStatus: 0x4959427a,                      // premium.boostsStatus#4959427a (line 1803)
  starsTransactionPeerUnsupported: 0x95f2bfe4,   // starsTransactionPeerUnsupported#95f2bfe4 (line 1953)
  starsTransaction: 0x13659eb0,                  // starsTransaction#13659eb0 (line 1964)
  starsStatus: 0x6c9ce8ed,                       // payments.starsStatus#6c9ce8ed (line 1966)
  starsTopupOption: 0xbd915c0,                   // starsTopupOption#bd915c0 (line 1962)
  starsGiftOption: 0x5e0589f1,                   // starsGiftOption#5e0589f1 (line 1984)
  starGift: 0x313a9547,                          // starGift#313a9547 (line 2002)
  starGifts: 0x2ed82995,                         // payments.starGifts#2ed82995 (line 2006)
  starsAmount: 0xbbb6b4a3,                       // starsAmount#bbb6b4a3 (line 2028)
  savedStarGift: 0x41df43fc,                     // savedStarGift#41df43fc (line 2052)
  savedStarGifts: 0x95f389b1,                    // payments.savedStarGifts#95f389b1 (line 2054)
  currencyRate: 0x30d9743c,                      // currencyRate#30d9743c (line 2297)
  currencyRates: 0xbbcce4c2,                     // payments.currencyRates#bbcce4c2 (line 2299)
});

/** Verified RPC constructor ids (schema/api.tl, layer 234). */
export const METHOD_IDS = Object.freeze({
  'payments.getPaymentForm': 0x37148dbb,              // line 3058
  'payments.getPaymentReceipt': 0x2478d1cc,           // line 3059
  'payments.validateRequestedInfo': 0xb6c8f12b,       // line 3060
  'payments.sendPaymentForm': 0x2d03522f,             // line 3061
  'payments.getSavedInfo': 0x227d824b,                // line 3062
  'payments.getBankCardData': 0x2e79d779,             // line 3064
  'payments.exportInvoice': 0xf91b065,                // line 3065
  'payments.getPremiumGiftCodeOptions': 0x2757ba54,   // line 3068
  'payments.getStarsTopupOptions': 0xc00ec7d3,        // line 3073
  'payments.getStarsStatus': 0x4ea9b3bf,              // line 3074
  'payments.getStarsTransactions': 0x69da4557,        // line 3075
  'payments.sendStarsForm': 0x7998c914,               // line 3076
  'payments.getStarsGiftOptions': 0xd3c96bc8,         // line 3082
  'payments.getStarGifts': 0xc4563590,                // line 3087
  'payments.getSavedStarGifts': 0xa319e569,           // line 3100
  'payments.getCurrencyRates': 0xd35983e8,            // line 3123
  'premium.getBoostsList': 0x60f67660,                // line 3262
  'premium.getMyBoosts': 0xbe77b4a,                   // line 3263
  'premium.applyBoost': 0x6b7da746,                   // line 3264
  'premium.getBoostsStatus': 0x42f1f61,               // line 3265
  'premium.getUserBoosts': 0x39854d1f,                // line 3266
});

const i32 = (v) => Number(v) | 0;
const now = () => Math.floor(Date.now() / 1000);

function toBig(v) {
  if (v === undefined || v === null || v === '') return 0n;
  if (typeof v === 'bigint') return v;
  const n = Number(v);
  return Number.isFinite(n) ? BigInt(Math.trunc(n)) : 0n;
}

function boolTrue() {
  return new TLBuffer().putUint(PAYMENTS_ID.boolTrue).buffer;
}

/** Lazily resolve a dedicated payment store (parallel to the other handlers). */
export function paymentStoreOf(ctx = {}) {
  if (ctx.paymentStore) return ctx.paymentStore;
  if (ctx._paymentStore) return ctx._paymentStore;
  const dataDir = ctx.dataDir || ctx.store?.dataDir || ctx.config?.dataDir || './data';
  ctx._paymentStore = new PaymentStore(dataDir);
  return ctx._paymentStore;
}

function currentUserId(ctx = {}) {
  if (ctx.userId) return Number(ctx.userId);
  if (ctx.user?.id) return Number(ctx.user.id);
  if (ctx.session?.userId) return Number(ctx.session.userId);
  const first = ctx.store?.driver?.all?.('users', {}, { limit: 1 })?.[0];
  return first ? Number(first.id ?? first.user_id) : 0;
}

function flagsOf(r) {
  return isReader(r) && r.has(4) ? r.uint() : 0;
}

function peerKeyOf(peer, fallbackType = 'channel') {
  if (peer && typeof peer === 'object') {
    const type = String(peer.type || peer.peerType || fallbackType);
    return `${type}:${Number(peer.id ?? peer.peerId ?? 0) || 0}`;
  }
  if (peer === undefined || peer === null || peer === '') return `${fallbackType}:0`;
  if (typeof peer === 'string' && peer.includes(':')) return peer;
  return `${fallbackType}:${Number(peer) || 0}`;
}

// ---- minimal request-parameter skippers ---------------------------------
function skipTextWithEntities(r) {
  if (!isReader(r) || !r.has(4)) return;
  r.uint(); // textWithEntities#751f3146
  if (r.has(1)) r.string();
  if (r.has(4)) {
    r.uint(); // vector id
    if (r.has(4)) r.int(); // element count
  }
}

function skipInputInvoice(r) {
  if (!isReader(r) || !r.has(4)) return { type: 'unknown', id: 0 };
  const ctor = r.uint() >>> 0;
  switch (ctor) {
    case 0xc5b56859: // inputInvoiceMessage peer:InputPeer msg_id:int
      readInputPeer(r);
      if (r.has(4)) r.int();
      return { type: 'message' };
    case 0xc326caef: // inputInvoiceSlug slug:string
      return { type: 'slug', slug: r.has(1) ? r.string() : '' };
    case 0x34e793f1: // inputInvoiceChatInviteSubscription hash:string
      return { type: 'chatInvite', hash: r.has(1) ? r.string() : '' };
    case 0x65f00ce3: // inputInvoiceStars purpose:InputStorePaymentPurpose
    case 0x98986c0d: // inputInvoicePremiumGiftCode purpose option
    case 0x3e77f614: // inputInvoicePremiumAuthCode purpose
      if (r.has(4)) r.uint(); // purpose constructor
      return { type: 'store' };
    case 0xe8625e92: { // inputInvoiceStarGift flags peer gift_id message
      const flags = flagsOf(r);
      readInputPeer(r);
      if (r.has(8)) r.long();
      if (flags & 1) skipTextWithEntities(r);
      return { type: 'starGift' };
    }
    default:
      return { type: 'unknown', constructor: ctor };
  }
}

function skipInputPaymentCredentials(r) {
  if (!isReader(r) || !r.has(4)) return;
  const ctor = r.uint() >>> 0;
  if (ctor === 0x3417d728) {
    const flags = flagsOf(r);
    if (r.has(4)) r.int(); // data:DataJSON constructor placeholder
    if (flags & 1 && r.has(1)) r.string();
  } else if (ctor === 0xc10eb2cf) {
    if (r.has(1)) r.string(); // id
    if (r.has(1)) r.bytes(); // tmp_password
  }
}

function invoiceRefOf(params) {
  const p = params && typeof params === 'object' && !isReader(params) ? params : {};
  return p.invoice?.id ?? p.invoiceId ?? p.id ?? 0;
}

// ---- local TL encoders ---------------------------------------------------
function putDouble(b, value) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(Number(value) || 0, 0);
  return b.putRaw(buf);
}

function tlInvoice(inv = {}) {
  const b = new TLBuffer();
  b.putUint(PAYMENTS_ID.invoice).putUint(0); // all optional flags omitted
  b.putString(inv.currency || '');
  b.putVector(inv.prices || [], (price, bb) => bb
    .putUint(PAYMENTS_ID.labeledPrice)
    .putString(price.label || '')
    .putLong(toBig(price.amount)));
  return b.buffer;
}

function tlPaymentRequestedInfo(info = {}) {
  const flags = (info.name ? 1 : 0) | (info.phone ? 2 : 0) | (info.email ? 4 : 0);
  const b = new TLBuffer().putUint(PAYMENTS_ID.paymentRequestedInfo).putUint(flags);
  if (flags & 1) b.putString(info.name);
  if (flags & 2) b.putString(info.phone);
  if (flags & 4) b.putString(info.email);
  return b.buffer;
}

function tlUpdates() {
  const b = new TLBuffer();
  b.putUint(PAYMENTS_ID.updates);
  b.putVector([], () => {});
  b.putVector([], () => {});
  b.putVector([], () => {});
  b.putInt(i32(now())).putInt(0);
  return b.buffer;
}

function tlPaymentResult() {
  return new TLBuffer().putUint(PAYMENTS_ID.paymentResult).putRaw(tlUpdates()).buffer;
}

/** payments.paymentForm#a0058751 (flags=0 variant). */
function tlPaymentForm(form = {}) {
  const b = new TLBuffer();
  b.putUint(PAYMENTS_ID.paymentForm).putUint(0);
  b.putLong(toBig(form.formId));
  b.putLong(toBig(form.botId));
  b.putString(form.title || '');
  b.putString(form.description || '');
  b.putRaw(tlInvoice(form.invoice || {}));
  b.putLong(toBig(form.providerId));
  b.putString(form.url || '');
  b.putVector([], () => {}); // users
  return b.buffer;
}

/** payments.paymentReceipt#70c4fe03 (flags=0 variant). */
function tlPaymentReceipt(receipt = {}) {
  const b = new TLBuffer();
  b.putUint(PAYMENTS_ID.paymentReceipt).putUint(0);
  b.putInt(i32(receipt.date));
  b.putLong(toBig(receipt.botId));
  b.putLong(toBig(receipt.providerId));
  b.putString(receipt.title || '');
  b.putString(receipt.description || '');
  b.putRaw(tlInvoice(receipt.invoice || {}));
  b.putString(receipt.currency || '');
  b.putLong(toBig(receipt.totalAmount));
  b.putString(receipt.credentialsTitle || '');
  b.putVector([], () => {}); // users
  return b.buffer;
}

/** payments.validatedRequestedInfo#d1451883 (id optional, no shipping opts). */
function tlValidatedRequestedInfo(info = {}) {
  const hasId = info.id !== undefined && info.id !== null && info.id !== '';
  const b = new TLBuffer()
    .putUint(PAYMENTS_ID.validatedRequestedInfo)
    .putUint(hasId ? 1 : 0);
  if (hasId) b.putString(info.id);
  return b.buffer;
}

/** payments.savedInfo#fb8fe43c. */
function tlSavedInfo(info) {
  const hasInfo = Boolean(info && Object.keys(info).length);
  const b = new TLBuffer().putUint(PAYMENTS_ID.savedInfo).putUint(hasInfo ? 1 : 0);
  if (hasInfo) b.putRaw(tlPaymentRequestedInfo(info));
  return b.buffer;
}

/** payments.bankCardData#3e24e573. */
function tlBankCardData(data = {}) {
  const b = new TLBuffer()
    .putUint(PAYMENTS_ID.bankCardData)
    .putString(data.title || 'Bank card');
  b.putVector(data.openUrls || [], (url, bb) => bb
    .putUint(PAYMENTS_ID.bankCardOpenUrl)
    .putString(url.url || '')
    .putString(url.name || ''));
  return b.buffer;
}

/** starsAmount#bbb6b4a3. */
function tlStarsAmount(amount = 0, nanos = 0) {
  return new TLBuffer()
    .putUint(PAYMENTS_ID.starsAmount)
    .putLong(toBig(amount))
    .putInt(i32(nanos))
    .buffer;
}

/** starsTransaction#13659eb0 (flags=0, unsupported peer). */
function tlStarsTransaction(tx = {}) {
  const b = new TLBuffer().putUint(PAYMENTS_ID.starsTransaction).putUint(0);
  b.putString(tx.id || '');
  b.putRaw(tlStarsAmount(tx.amount));
  b.putInt(i32(tx.date));
  b.putUint(PAYMENTS_ID.starsTransactionPeerUnsupported);
  return b.buffer;
}

/** payments.starsStatus#6c9ce8ed. */
function tlStarsStatus({ balance = 0, transactions = [], nextOffset = '' } = {}) {
  const flags = (transactions.length ? 1 << 3 : 0) | (nextOffset ? 1 : 0);
  const b = new TLBuffer().putUint(PAYMENTS_ID.starsStatus).putUint(flags);
  b.putRaw(tlStarsAmount(balance));
  // subscriptions / subscriptions_next_offset / subscriptions_missing_balance omitted
  if (flags & (1 << 3)) {
    b.putVector(transactions, (tx, bb) => bb.putRaw(Buffer.isBuffer(tx) ? tx : tlStarsTransaction(tx)));
  }
  if (flags & 1) b.putString(nextOffset);
  b.putVector([], () => {}); // chats
  b.putVector([], () => {}); // users
  return b.buffer;
}

/** starGift#313a9547 (flags=0 variant with documentEmpty sticker). */
function tlStarGift(gift = {}) {
  const b = new TLBuffer().putUint(PAYMENTS_ID.starGift).putUint(0);
  b.putLong(toBig(gift.id));
  b.putUint(PAYMENTS_ID.documentEmpty).putLong(toBig(gift.documentId ?? 0));
  b.putLong(toBig(gift.stars));
  b.putLong(toBig(gift.convertStars));
  return b.buffer;
}

/** payments.starGifts#2ed82995. */
function tlStarGifts({ hash = 0, gifts = [] } = {}) {
  const b = new TLBuffer()
    .putUint(PAYMENTS_ID.starGifts)
    .putInt(i32(hash));
  b.putVector(gifts, (gift, bb) => bb.putRaw(Buffer.isBuffer(gift) ? gift : tlStarGift(gift)));
  b.putVector([], () => {}); // chats
  b.putVector([], () => {}); // users
  return b.buffer;
}

/** savedStarGift#41df43fc (flags=0 variant). */
function tlSavedStarGift(gift = {}) {
  const b = new TLBuffer().putUint(PAYMENTS_ID.savedStarGift).putUint(0);
  b.putInt(i32(gift.date));
  b.putRaw(tlStarGift(gift.gift || gift));
  return b.buffer;
}

/** payments.savedStarGifts#95f389b1. */
function tlSavedStarGifts({ count = 0, gifts = [] } = {}) {
  const b = new TLBuffer()
    .putUint(PAYMENTS_ID.savedStarGifts)
    .putUint(0)
    .putInt(i32(count));
  b.putVector(gifts, (gift, bb) => bb.putRaw(Buffer.isBuffer(gift) ? gift : tlSavedStarGift(gift)));
  b.putVector([], () => {}); // chats
  b.putVector([], () => {}); // users
  return b.buffer;
}

function tlStarsTopupOption(option = {}) {
  return new TLBuffer()
    .putUint(PAYMENTS_ID.starsTopupOption)
    .putUint(0)
    .putLong(toBig(option.stars))
    .putString(option.currency || 'USD')
    .putLong(toBig(option.amount))
    .buffer;
}

function tlStarsGiftOption(option = {}) {
  return new TLBuffer()
    .putUint(PAYMENTS_ID.starsGiftOption)
    .putUint(0)
    .putLong(toBig(option.stars))
    .putString(option.currency || 'USD')
    .putLong(toBig(option.amount))
    .buffer;
}

function tlPremiumGiftCodeOption(option = {}) {
  return new TLBuffer()
    .putUint(PAYMENTS_ID.premiumGiftCodeOption)
    .putUint(0)
    .putInt(i32(option.users ?? 1))
    .putInt(i32(option.months ?? 1))
    .putString(option.currency || 'USD')
    .putLong(toBig(option.amount))
    .buffer;
}

function tlBoost(boost = {}) {
  return new TLBuffer()
    .putUint(PAYMENTS_ID.boost)
    .putUint(0)
    .putString(boost.id || '')
    .putInt(i32(boost.date))
    .putInt(i32(boost.expires))
    .buffer;
}

/** premium.boostsList#86f8613c. */
function tlBoostsList({ boosts = [] } = {}) {
  const b = new TLBuffer().putUint(PAYMENTS_ID.boostsList).putUint(0);
  b.putInt(i32(boosts.length));
  b.putVector(boosts, (boost, bb) => bb.putRaw(Buffer.isBuffer(boost) ? boost : tlBoost(boost)));
  b.putVector([], () => {}); // users
  return b.buffer;
}

/** myBoost#c448415c. */
function tlMyBoost(boost = {}) {
  return new TLBuffer()
    .putUint(PAYMENTS_ID.myBoost)
    .putUint(0)
    .putInt(i32(boost.slot))
    .putInt(i32(boost.date))
    .putInt(i32(boost.expires))
    .buffer;
}

/** premium.myBoosts#9ae228e2. */
function tlMyBoosts({ boosts = [] } = {}) {
  const b = new TLBuffer().putUint(PAYMENTS_ID.myBoosts);
  b.putVector(boosts, (boost, bb) => bb.putRaw(Buffer.isBuffer(boost) ? boost : tlMyBoost(boost)));
  b.putVector([], () => {}); // chats
  b.putVector([], () => {}); // users
  return b.buffer;
}

/** premium.boostsStatus#4959427a. */
function tlBoostsStatus({ level = 0, current = 0, boosts = 0, boostUrl = '' } = {}) {
  return new TLBuffer()
    .putUint(PAYMENTS_ID.boostsStatus)
    .putUint(0)
    .putInt(i32(level))
    .putInt(i32(current))
    .putInt(i32(boosts))
    .putString(boostUrl)
    .buffer;
}

/** payments.currencyRates#bbcce4c2 with currencyRate#30d9743c items. */
function tlCurrencyRates(rates = []) {
  const b = new TLBuffer().putUint(PAYMENTS_ID.currencyRates);
  b.putVector(rates, (rate, bb) => {
    bb.putUint(PAYMENTS_ID.currencyRate).putString(rate.currency || 'USD');
    putDouble(bb, rate.rate ?? 1);
  });
  return b.buffer;
}

function vectorOf(items, encode) {
  return new TLBuffer().putVector(items, encode).buffer;
}

// ---- handlers ------------------------------------------------------------

/** payments.getPaymentForm#37148dbb -> payments.paymentForm#a0058751. */
export function getPaymentForm(params, ctx = {}) {
  let flags = 0;
  if (isReader(params)) {
    flags = flagsOf(params);
    skipInputInvoice(params);
    if (flags & 1) skipJSONValue(params);
  }
  const ref = invoiceRefOf(params);
  const invoice = paymentStoreOf(ctx).getInvoice(ref) || null;
  return tlPaymentForm({
    formId: ref,
    botId: 0,
    title: invoice?.title || '',
    description: invoice?.description || '',
    invoice: invoice || { currency: 'XTR' },
    providerId: 0,
    url: '',
  });
}

/** payments.getPaymentReceipt#2478d1cc -> payments.paymentReceipt#70c4fe03. */
export function getPaymentReceipt(params, ctx = {}) {
  let msgId = 0;
  if (isReader(params)) {
    readInputPeer(params);
    msgId = params.has(4) ? params.int() : 0;
  } else {
    msgId = Number(params?.msgId ?? params?.msg_id ?? params?.paymentId ?? params?.id ?? 0) || 0;
  }
  const receipt = paymentStoreOf(ctx).getPaymentReceipt(msgId) || null;
  return tlPaymentReceipt({
    date: receipt?.date ?? 0,
    botId: 0,
    providerId: 0,
    title: receipt?.title || '',
    description: receipt?.description || '',
    invoice: receipt?.invoice || {},
    currency: receipt?.currency || '',
    totalAmount: receipt?.amount ?? 0,
    credentialsTitle: '',
  });
}

/** payments.validateRequestedInfo#b6c8f12b -> payments.validatedRequestedInfo#d1451883. */
export function validateRequestedInfo(params, ctx = {}) {
  let flags = 0;
  let info = null;
  if (isReader(params)) {
    flags = flagsOf(params);
    skipInputInvoice(params);
    const infoFlags = flagsOf(params);
    info = {
      name: (infoFlags & 1) && params.has(1) ? params.string() : undefined,
      phone: (infoFlags & 2) && params.has(1) ? params.string() : undefined,
      email: (infoFlags & 4) && params.has(1) ? params.string() : undefined,
    };
  } else {
    flags = Number(params?.save) || Number(params?.flags) || 0;
    info = params?.info || null;
  }
  const me = currentUserId(ctx);
  const save = Boolean(flags & 1);
  if (save && info) paymentStoreOf(ctx).saveRequestedInfo(me, info);
  return tlValidatedRequestedInfo({ id: save && info ? `req:${me}` : '' });
}

/** payments.sendPaymentForm#2d03522f -> payments.paymentResult#4e5f810d. */
export function sendPaymentForm(params, ctx = {}) {
  let formId = 0;
  if (isReader(params)) {
    const flags = flagsOf(params);
    formId = Number(params.has(8) ? params.long() : 0n);
    skipInputInvoice(params);
    if (flags & 1 && params.has(1)) params.string(); // requested_info_id
    if (flags & 2 && params.has(1)) params.string(); // shipping_option_id
    skipInputPaymentCredentials(params);
    if (flags & 4 && params.has(8)) params.long(); // tip_amount
  } else {
    formId = Number(params?.formId ?? params?.form_id ?? 0) || 0;
    const store = paymentStoreOf(ctx);
    if (store.getPayment(formId)) store.completePayment(formId, params?.chargeId || `charge_${formId}`);
  }
  return tlPaymentResult();
}

/** payments.getSavedInfo#227d824b -> payments.savedInfo#fb8fe43c. */
export function getSavedInfo(params, ctx = {}) {
  const info = paymentStoreOf(ctx).getRequestedInfo(currentUserId(ctx));
  return tlSavedInfo(info);
}

/** payments.getBankCardData#2e79d779 -> payments.bankCardData#3e24e573. */
export function getBankCardData(params, ctx = {}) {
  if (isReader(params) && params.has(1)) params.string(); // number
  return tlBankCardData({
    title: 'Bank card',
    openUrls: [{ url: 'https://example.com/bank-card', name: 'Bank' }],
  });
}

/** payments.exportInvoice#f91b065 -> payments.exportedInvoice#aed0cbd9. */
export function exportInvoice(params, ctx = {}) {
  if (isReader(params) && params.has(4)) params.uint(); // InputMedia constructor
  return new TLBuffer()
    .putUint(PAYMENTS_ID.exportedInvoice)
    .putString('https://t.me/invoice/0')
    .buffer;
}

/** payments.getStarsStatus#4ea9b3bf -> payments.starsStatus#6c9ce8ed. */
export function getStarsStatus(params, ctx = {}) {
  if (isReader(params)) {
    flagsOf(params); // ton flag
    readInputPeer(params);
  }
  const me = currentUserId(ctx);
  const store = paymentStoreOf(ctx);
  return tlStarsStatus({
    balance: store.getStarsBalance(me),
    transactions: store.listStarsTransactions(me),
  });
}

/** payments.sendStarsForm#7998c914 -> payments.paymentResult#4e5f810d. */
export function sendStarsForm(params, ctx = {}) {
  let formId = 0;
  if (isReader(params)) {
    formId = Number(params.has(8) ? params.long() : 0n);
    skipInputInvoice(params);
  } else {
    formId = Number(params?.formId ?? params?.form_id ?? 0) || 0;
  }
  const store = paymentStoreOf(ctx);
  if (store.getPayment(formId)) store.completePayment(formId, params?.chargeId || `charge_${formId}`);
  return tlPaymentResult();
}

/** payments.getStarsTransactions#69da4557 -> payments.starsStatus#6c9ce8ed. */
export function getStarsTransactions(params, ctx = {}) {
  let limit = 0;
  if (isReader(params)) {
    const flags = flagsOf(params);
    if (flags & 8 && params.has(1)) params.string(); // subscription_id
    readInputPeer(params);
    if (params.has(1)) params.string(); // offset
    limit = params.has(4) ? params.int() : 0;
  } else {
    limit = Number(params?.limit ?? 0) || 0;
  }
  const me = currentUserId(ctx);
  const store = paymentStoreOf(ctx);
  let transactions = store.listStarsTransactions(me);
  if (limit > 0) transactions = transactions.slice(0, limit);
  return tlStarsStatus({ balance: store.getStarsBalance(me), transactions });
}

/** payments.getStarGifts#c4563590 -> payments.starGifts#2ed82995. */
export function getStarGifts(params, ctx = {}) {
  const hash = isReader(params) && params.has(4) ? params.int() : Number(params?.hash ?? 0) || 0;
  return tlStarGifts({ hash, gifts: paymentStoreOf(ctx).listStarGifts() });
}

/** payments.getSavedStarGifts#a319e569 -> payments.savedStarGifts#95f389b1. */
export function getSavedStarGifts(params, ctx = {}) {
  if (isReader(params)) {
    const flags = flagsOf(params);
    readInputPeer(params);
    if (flags & (1 << 6) && params.has(4)) params.int(); // collection_id
    if (params.has(1)) params.string(); // offset
    if (params.has(4)) params.int(); // limit
  }
  return tlSavedStarGifts({ count: 0, gifts: [] });
}

/** payments.getStarsGiftOptions#d3c96bc8 -> Vector<StarsGiftOption>. */
export function getStarsGiftOptions(params, ctx = {}) {
  if (isReader(params)) {
    if (flagsOf(params) & 1) readInputUser(params);
  }
  const options = (!isReader(params) && Array.isArray(params?.options) && params.options.length)
    ? params.options
    : [{ stars: 50, currency: 'USD', amount: 50 }];
  return vectorOf(options, (option, b) => b.putRaw(tlStarsGiftOption(option)));
}

/** payments.getStarsTopupOptions#c00ec7d3 -> Vector<StarsTopupOption>. */
export function getStarsTopupOptions(params, ctx = {}) {
  const options = (!isReader(params) && Array.isArray(params?.options) && params.options.length)
    ? params.options
    : [{ stars: 100, currency: 'USD', amount: 100 }];
  return vectorOf(options, (option, b) => b.putRaw(tlStarsTopupOption(option)));
}

/** payments.getPremiumGiftCodeOptions#2757ba54 -> Vector<PremiumGiftCodeOption>. */
export function getPremiumGiftCodeOptions(params, ctx = {}) {
  if (isReader(params)) {
    if (flagsOf(params) & 1) readInputPeer(params);
  }
  const options = (!isReader(params) && Array.isArray(params?.options) && params.options.length)
    ? params.options
    : [{ users: 1, months: 1, currency: 'USD', amount: 200 }];
  return vectorOf(options, (option, b) => b.putRaw(tlPremiumGiftCodeOption(option)));
}

/** premium.getBoostsList#60f67660 -> premium.boostsList#86f8613c. */
export function getBoostsList(params, ctx = {}) {
  if (isReader(params)) {
    flagsOf(params); // gifts flag
    readInputPeer(params);
    if (params.has(1)) params.string(); // offset
    if (params.has(4)) params.int(); // limit
  }
  const me = currentUserId(ctx);
  return tlBoostsList({ boosts: paymentStoreOf(ctx).getBoosts(me) });
}

/** premium.getMyBoosts#be77b4a -> premium.myBoosts#9ae228e2. */
export function getMyBoosts(params, ctx = {}) {
  const me = currentUserId(ctx);
  return tlMyBoosts({ boosts: paymentStoreOf(ctx).getBoosts(me) });
}

/** premium.getBoostsStatus#42f1f61 -> premium.boostsStatus#4959427a. */
export function getBoostsStatus(params, ctx = {}) {
  if (isReader(params)) readInputPeer(params);
  const me = currentUserId(ctx);
  const boosts = paymentStoreOf(ctx).getBoosts(me).length;
  return tlBoostsStatus({ level: 0, current: 0, boosts, boostUrl: '' });
}

/** premium.applyBoost#6b7da746 -> premium.myBoosts#9ae228e2. */
export function applyBoost(params, ctx = {}) {
  let peer;
  if (isReader(params)) {
    const flags = flagsOf(params);
    if (flags & 1 && params.has(4)) {
      params.vector((rr) => rr.int()); // slots
    }
    peer = readInputPeer(params);
  } else {
    peer = params?.peer ?? params?.peerKey ?? 'channel:0';
  }
  paymentStoreOf(ctx).applyBoost(currentUserId(ctx), peerKeyOf(peer));
  return tlMyBoosts({ boosts: paymentStoreOf(ctx).getBoosts(currentUserId(ctx)) });
}

/** premium.getUserBoosts#39854d1f -> premium.boostsList#86f8613c. */
export function getUserBoosts(params, ctx = {}) {
  let target = currentUserId(ctx);
  if (isReader(params)) {
    readInputPeer(params);
    target = Number(readInputUser(params).id ?? target) || target;
  } else if (params?.userId !== undefined) {
    target = Number(params.userId) || target;
  }
  return tlBoostsList({ boosts: paymentStoreOf(ctx).getBoosts(target) });
}

/** payments.getCurrencyRates#d35983e8 -> payments.currencyRates#bbcce4c2. */
export function getCurrencyRates(params, ctx = {}) {
  const rates = (!isReader(params) && Array.isArray(params?.rates) && params.rates.length)
    ? params.rates
    : [{ currency: 'USD', rate: 1 }];
  return tlCurrencyRates(rates);
}

export default {
  PAYMENTS_ID,
  METHOD_IDS,
  paymentStoreOf,
  getPaymentForm,
  getPaymentReceipt,
  validateRequestedInfo,
  sendPaymentForm,
  getSavedInfo,
  getBankCardData,
  exportInvoice,
  getStarsStatus,
  sendStarsForm,
  getStarsTransactions,
  getStarGifts,
  getSavedStarGifts,
  getStarsGiftOptions,
  getStarsTopupOptions,
  getPremiumGiftCodeOptions,
  getBoostsList,
  getMyBoosts,
  getBoostsStatus,
  applyBoost,
  getUserBoosts,
  getCurrencyRates,
};
