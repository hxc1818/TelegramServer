// PaymentStore and payments / stars / boosts RPC handler tests (layer 234).
// Constructor ids are verified against the pinned schema/api.tl.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { loadSchema } from '../src/tl/schema.js';
import { PaymentStore } from '../src/store/payments.js';
import * as P from '../src/rpc/handlers/payments.js';

const { PAYMENTS_ID: ID, METHOD_IDS } = P;

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-payments-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCtx(dir, userId = 7) {
  const paymentStore = new PaymentStore(dir);
  return {
    paymentStore,
    ctx: { paymentStore, userId, store: { dataDir: dir } },
  };
}

const TYPES = {
  boolTrue: 'boolTrue',
  vector: 'vector',
  documentEmpty: 'documentEmpty',
  dataJSON: 'dataJSON',
  labeledPrice: 'labeledPrice',
  invoice: 'invoice',
  paymentCharge: 'paymentCharge',
  paymentRequestedInfo: 'paymentRequestedInfo',
  paymentForm: 'payments.paymentForm',
  validatedRequestedInfo: 'payments.validatedRequestedInfo',
  paymentResult: 'payments.paymentResult',
  paymentReceipt: 'payments.paymentReceipt',
  savedInfo: 'payments.savedInfo',
  shippingOption: 'shippingOption',
  bankCardOpenUrl: 'bankCardOpenUrl',
  bankCardData: 'payments.bankCardData',
  exportedInvoice: 'payments.exportedInvoice',
  updates: 'updates',
  premiumGiftCodeOption: 'premiumGiftCodeOption',
  boost: 'boost',
  boostsList: 'premium.boostsList',
  myBoost: 'myBoost',
  myBoosts: 'premium.myBoosts',
  boostsStatus: 'premium.boostsStatus',
  starsTransactionPeerUnsupported: 'starsTransactionPeerUnsupported',
  starsTransaction: 'starsTransaction',
  starsStatus: 'payments.starsStatus',
  starsTopupOption: 'starsTopupOption',
  starsGiftOption: 'starsGiftOption',
  starGift: 'starGift',
  starGifts: 'payments.starGifts',
  starsAmount: 'starsAmount',
  savedStarGift: 'savedStarGift',
  savedStarGifts: 'payments.savedStarGifts',
  currencyRate: 'currencyRate',
  currencyRates: 'payments.currencyRates',
};

test('every payments constructor/method id matches schema/api.tl (layer 234)', () => {
  const schema = loadSchema();
  assert.equal(schema.layer, 234);
  for (const [key, name] of Object.entries(TYPES)) {
    const entry = schema.types.get(name);
    assert.ok(entry, `schema missing type ${name}`);
    assert.equal(ID[key], entry.id, `${key} != ${name}`);
  }
  assert.equal(Object.keys(METHOD_IDS).length, 21);
  for (const [name, id] of Object.entries(METHOD_IDS)) {
    const entry = schema.functions.get(name);
    assert.ok(entry, `schema missing function ${name}`);
    assert.equal(id, entry.id, `${name} id mismatch`);
  }
  // Boost RPCs live under premium.* in layer 234, not under payments.*.
  assert.equal(schema.functions.has('premium.getBoostsList'), true);
  assert.equal(schema.functions.has('payments.getBoostsList'), false);
});

test('PaymentStore handles invoice / requested info / payment CRUD', () => {
  const dir = tempDir();
  const store = new PaymentStore(dir);
  try {
    if (store.driverKind === 'sqlite') assert.ok(fs.existsSync(path.join(dir, 'payments.sqlite')));

    const invoice = store.createInvoice({
      title: 'Green Tea', description: 'A warm cup', amount: 100n, currency: 'USD', userId: 7,
    });
    assert.equal(invoice.title, 'Green Tea');
    assert.equal(invoice.amount, 100);
    assert.equal(store.getInvoice(invoice.id).description, 'A warm cup');
    assert.equal(store.getInvoice(invoice.id).currency, 'USD');
    assert.equal(store.getInvoice(9999), null);

    assert.equal(store.getRequestedInfo(7), null);
    store.saveRequestedInfo(7, { name: 'Ann', phone: '+15551234', email: 'ann@example.com' });
    assert.equal(store.getRequestedInfo(7).name, 'Ann');
    assert.equal(store.getRequestedInfo(7).email, 'ann@example.com');
    store.saveRequestedInfo(7, { name: 'Anne' });
    assert.equal(store.getRequestedInfo(7).name, 'Anne');

    const payment = store.createPayment(invoice.id, 7, 'stripe', { name: 'Anne' });
    assert.equal(payment.status, 'pending');
    assert.equal(payment.invoiceId, invoice.id);
    assert.equal(payment.info.name, 'Anne');
    assert.equal(store.listPayments(7).length, 1);
    assert.equal(store.listPayments(8).length, 0);

    const done = store.completePayment(payment.id, 'charge-abc');
    assert.equal(done.status, 'completed');
    assert.equal(done.chargeId, 'charge-abc');
    assert.equal(store.completePayment(9999, 'x'), null);

    const receipt = store.getPaymentReceipt(payment.id);
    assert.equal(receipt.title, 'Green Tea');
    assert.equal(receipt.amount, 100);
    assert.equal(receipt.currency, 'USD');
    assert.equal(receipt.chargeId, 'charge-abc');
    assert.equal(store.getPaymentReceipt(9999), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PaymentStore tracks Stars balance and transactions safely', () => {
  const dir = tempDir();
  const store = new PaymentStore(dir);
  try {
    assert.equal(store.getStarsBalance(7), 0);
    assert.equal(store.addStars(7, 500), 500);
    assert.equal(store.addStars(7, 250), 750);
    assert.equal(store.spendStars(7, 120), 630);
    assert.equal(store.getStarsBalance(7), 630);
    assert.equal(store.spendStars(7, 100000), null); // insufficient funds
    assert.equal(store.getStarsBalance(7), 630);

    const tx = store.addTransaction(7, -30, 'tip');
    assert.equal(tx.delta, -30);
    assert.equal(tx.description, 'tip');
    assert.equal(store.getStarsBalance(7), 600);
    const transactions = store.listStarsTransactions(7);
    assert.equal(transactions.length, 4);
    assert.deepEqual(transactions.map((t) => Number(t.delta)).sort((a, b) => a - b), [-120, -30, 250, 500]);
    assert.equal(store.listStarsTransactions(8).length, 0);

    // int64-sized amounts are returned without precision loss.
    const big = 9007199254740993n;
    store.addStars(9, big);
    assert.equal(BigInt(store.getStarsBalance(9)), big);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PaymentStore handles star gifts, purchases, boosts and Premium state', () => {
  const dir = tempDir();
  const store = new PaymentStore(dir);
  try {
    const gift = store.createStarGift({ id: 55n, title: 'Rose', stars: 100n, convertStars: 50n });
    assert.equal(gift.id, 55);
    assert.equal(gift.title, 'Rose');
    assert.equal(store.getStarGift(55n).title, 'Rose');
    assert.equal(store.listStarGifts().length, 1);
    // Purchases require enough Stars.
    assert.equal(store.purchaseGift(7, 55n), null);
    store.addStars(7, 300);
    const purchase = store.purchaseGift(7, 55n);
    assert.equal(purchase.giftId, 55);
    assert.equal(store.getStarsBalance(7), 200);
    assert.equal(store.listGiftPurchases(7).length, 1);
    assert.equal(store.purchaseGift(7, 9999), null);

    assert.deepEqual(store.getBoosts(7), []);
    const first = store.applyBoost(7, 'channel:42');
    const second = store.applyBoost(7, 'chat:9');
    assert.ok(second.id > first.id);
    assert.equal(store.getBoosts(7).length, 2);
    assert.deepEqual(store.getBoosts(7).map((b) => b.peerKey).sort(), ['channel:42', 'chat:9']);
    assert.equal(store.getBoosts(8).length, 0);

    assert.deepEqual(store.getPremiumStatus(7), { userId: 7, active: false, until: 0 });
    store.setPremium(7, true, 12345);
    assert.deepEqual(store.getPremiumStatus(7), { userId: 7, active: true, until: 12345 });
    store.setPremium(7, false, 0);
    assert.equal(store.getPremiumStatus(7).active, false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PaymentStore has a JSON fallback driver that persists across reopen', () => {
  const dir = tempDir();
  const store = new PaymentStore({ dataDir: dir, driver: 'json' });
  try {
    assert.equal(store.driverKind, 'json');
    assert.ok(fs.existsSync(path.join(dir, 'payments.json')));
    const invoice = store.createInvoice({ title: 'JSON', amount: 5n, currency: 'XTR', userId: 7 });
    store.saveRequestedInfo(7, { name: 'Json User' });
    const payment = store.createPayment(invoice.id, 7, 'wallet', {});
    store.completePayment(payment.id, 'json-charge');
    store.addStars(7, 100);
    store.spendStars(7, 25);
    store.createStarGift({ id: 3n, title: 'Gift', stars: 10n });
    store.applyBoost(7, 'channel:1');
    store.setPremium(7, true, 999);

    store.close();
    const reopened = new PaymentStore({ dataDir: dir, driver: 'json' });
    try {
      assert.equal(reopened.driverKind, 'json');
      assert.equal(reopened.getInvoice(invoice.id).title, 'JSON');
      assert.equal(reopened.getRequestedInfo(7).name, 'Json User');
      assert.equal(reopened.getPayment(payment.id).chargeId, 'json-charge');
      assert.equal(reopened.getStarsBalance(7), 75);
      assert.equal(reopened.listStarsTransactions(7).length, 2);
      assert.equal(reopened.getStarGift(3n).title, 'Gift');
      assert.equal(reopened.getBoosts(7).length, 1);
      assert.equal(reopened.getPremiumStatus(7).active, true);
    } finally {
      reopened.close();
    }
  } finally {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const HANDLERS = [
  ['getPaymentForm', ID.paymentForm],
  ['getPaymentReceipt', ID.paymentReceipt],
  ['validateRequestedInfo', ID.validatedRequestedInfo],
  ['sendPaymentForm', ID.paymentResult],
  ['getSavedInfo', ID.savedInfo],
  ['getBankCardData', ID.bankCardData],
  ['exportInvoice', ID.exportedInvoice],
  ['getStarsStatus', ID.starsStatus],
  ['sendStarsForm', ID.paymentResult],
  ['getStarsTransactions', ID.starsStatus],
  ['getStarGifts', ID.starGifts],
  ['getSavedStarGifts', ID.savedStarGifts],
  ['getStarsGiftOptions', ID.vector],
  ['getStarsTopupOptions', ID.vector],
  ['getPremiumGiftCodeOptions', ID.vector],
  ['getBoostsList', ID.boostsList],
  ['getMyBoosts', ID.myBoosts],
  ['getBoostsStatus', ID.boostsStatus],
  ['applyBoost', ID.myBoosts],
  ['getUserBoosts', ID.boostsList],
  ['getCurrencyRates', ID.currencyRates],
];

test('all 21 payments/premium handlers return their verified constructor ids', () => {
  const dir = tempDir();
  const { paymentStore, ctx } = makeCtx(dir);
  try {
    for (const [name, ctor] of HANDLERS) {
      const buf = P[name]({}, ctx);
      assert.ok(Buffer.isBuffer(buf) && buf.length >= 4, `${name} returned no buffer`);
      assert.equal(new TLBuffer(buf).uint(), ctor, `${name} wrong result constructor`);
    }
  } finally {
    paymentStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handlers accept a TLBuffer reader positioned after the request id', () => {
  const dir = tempDir();
  const { paymentStore, ctx } = makeCtx(dir);
  try {
    // payments.getPaymentForm#37148dbb flags:# invoice:InputInvoice theme_params:flags.0?DataJSON
    const formReq = new TLBuffer().putUint(0).putUint(0xc326caef).putString('slug-1').buffer;
    assert.equal(new TLBuffer(P.getPaymentForm(new TLBuffer(formReq), ctx)).uint(), ID.paymentForm);

    // payments.getBankCardData#2e79d779 number:string
    const cardReq = new TLBuffer().putString('4242424242424242').buffer;
    assert.equal(new TLBuffer(P.getBankCardData(new TLBuffer(cardReq), ctx)).uint(), ID.bankCardData);

    // payments.getStarGifts#c4563590 hash:int
    const giftsReq = new TLBuffer().putInt(0).buffer;
    assert.equal(new TLBuffer(P.getStarGifts(new TLBuffer(giftsReq), ctx)).uint(), ID.starGifts);

    // premium.applyBoost#6b7da746 flags:# slots:flags.0?Vector<int> peer:InputPeer
    const boostReq = new TLBuffer()
      .putUint(0)
      .putUint(0x27bcbbfc).putLong(99n).putLong(0n) // inputPeerChannel
      .buffer;
    const boosted = new TLBuffer(P.applyBoost(new TLBuffer(boostReq), ctx));
    assert.equal(boosted.uint(), ID.myBoosts);
    const boosts = boosted.vector((rr) => {
      assert.equal(rr.uint(), ID.myBoost);
      return true;
    });
    assert.equal(boosts.length, 1);
    assert.equal(paymentStore.getBoosts(7)[0].peerKey, 'channel:99');
  } finally {
    paymentStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getPaymentForm / getPaymentReceipt / getStarsStatus use stored data', () => {
  const dir = tempDir();
  const { paymentStore, ctx } = makeCtx(dir);
  try {
    const invoice = paymentStore.createInvoice({
      title: 'Green Tea', description: 'A warm cup', amount: 100n, currency: 'USD', userId: 7,
    });
    const form = new TLBuffer(P.getPaymentForm({ invoice: { id: invoice.id } }, ctx));
    assert.equal(form.uint(), ID.paymentForm);
    assert.equal(form.uint(), 0); // flags
    assert.equal(form.long(), BigInt(invoice.id));
    form.long(); // bot_id
    assert.equal(form.string(), 'Green Tea');
    assert.equal(form.string(), 'A warm cup');
    assert.equal(form.uint(), ID.invoice);
    form.uint(); // invoice flags
    assert.equal(form.string(), 'USD');
    assert.equal(form.vector(() => true).length, 0); // prices
    form.long(); // provider_id
    form.string(); // url
    assert.equal(form.vector(() => true).length, 0); // users

    const payment = paymentStore.createPayment(invoice.id, 7, 'stripe', {});
    paymentStore.completePayment(payment.id, 'charge-abc');
    const receipt = new TLBuffer(P.getPaymentReceipt({ msgId: payment.id }, ctx));
    assert.equal(receipt.uint(), ID.paymentReceipt);
    assert.equal(receipt.uint(), 0); // flags
    receipt.int(); // date
    receipt.long(); receipt.long(); // bot_id, provider_id
    assert.equal(receipt.string(), 'Green Tea');
    assert.equal(receipt.string(), 'A warm cup');
    assert.equal(receipt.uint(), ID.invoice);
    receipt.uint(); receipt.string(); receipt.vector(() => true);
    assert.equal(receipt.string(), 'USD');
    assert.equal(receipt.long(), 100n);
    receipt.string(); // credentials_title
    assert.equal(receipt.vector(() => true).length, 0); // users

    paymentStore.addStars(7, 300);
    paymentStore.addTransaction(7, -50, 'tip');
    const status = new TLBuffer(P.getStarsStatus({}, ctx));
    assert.equal(status.uint(), ID.starsStatus);
    const flags = status.uint();
    assert.ok(flags & 8, 'history vector present');
    assert.equal(status.uint(), ID.starsAmount);
    assert.equal(status.long(), 250n);
    status.int(); // nanos
    const history = status.vector((rr) => {
      assert.equal(rr.uint(), ID.starsTransaction);
      rr.uint(); // flags
      rr.string(); // id
      assert.equal(rr.uint(), ID.starsAmount);
      rr.long(); rr.int(); // amount, nanos
      rr.int(); // date
      rr.uint(); // peer
      return true;
    });
    assert.equal(history.length, 2);
    assert.equal(status.vector(() => true).length, 0); // chats
    assert.equal(status.vector(() => true).length, 0); // users

    const rates = new TLBuffer(P.getCurrencyRates({}, ctx));
    assert.equal(rates.uint(), ID.currencyRates);
    const list = rates.vector((rr) => {
      assert.equal(rr.uint(), ID.currencyRate);
      assert.equal(rr.string(), 'USD');
      assert.equal(rr.raw(8).readDoubleLE(0), 1);
      return true;
    });
    assert.equal(list.length, 1);
  } finally {
    paymentStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
