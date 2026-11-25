// Unit tests for the bot store and bot/inline/game/scheduled RPC handlers.
// All constructor ids are checked against the pinned schema/api.tl (layer 234).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { loadSchema } from '../src/tl/schema.js';
import { Store } from '../src/store/store.js';
import { BotStore } from '../src/store/bots.js';
import * as B from '../src/rpc/handlers/bots.js';

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-bots-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCtx(dir) {
  const store = new Store(dir);
  const botStore = new BotStore(dir);
  const user = store.createUser({ phone: '+15557654321', firstName: 'Bot', lastName: 'Tester' });
  store.createSession(user.id, '0011223344556677');
  return {
    store,
    botStore,
    user,
    ctx: {
      store, botStore, userId: user.id,
      session: { authKeyId: '0011223344556677', userId: user.id },
    },
  };
}

const TYPE_NAMES = {
  boolTrue: 'boolTrue',
  boolFalse: 'boolFalse',
  vector: 'vector',
  messagesBotResults: 'messages.botResults',
  botInlineResult: 'botInlineResult',
  botInlineMessageText: 'botInlineMessageText',
  messagesHighScores: 'messages.highScores',
  highScore: 'highScore',
  messagesMessages: 'messages.messages',
  updates: 'updates',
  updateNewMessage: 'updateNewMessage',
  updateDeleteMessages: 'updateDeleteMessages',
  updateShortSentMessage: 'updateShortSentMessage',
  affectedHistory: 'messages.affectedHistory',
  message: 'message',
  peerUser: 'peerUser',
  peerChat: 'peerChat',
  peerChannel: 'peerChannel',
  botsBotInfo: 'bots.botInfo',
  botCommand: 'botCommand',
  botMenuButtonDefault: 'botMenuButtonDefault',
  inputBotInlineMessageText: 'inputBotInlineMessageText',
};

test('every bot constructor/method id matches schema/api.tl (layer 234)', () => {
  const schema = loadSchema();
  assert.equal(schema.layer, 234);
  for (const [key, name] of Object.entries(TYPE_NAMES)) {
    const entry = schema.types.get(name);
    assert.ok(entry, `schema missing type ${name}`);
    assert.equal(B.BOT_ID[key], entry.id, `${key} != ${name}`);
  }
  for (const [name, id] of Object.entries(B.METHOD_IDS)) {
    const entry = schema.functions.get(name);
    assert.ok(entry, `schema missing function ${name}`);
    assert.equal(id, entry.id, `${name} id mismatch`);
  }
  // Explicitly absent in layer 234 (documented in the handler module).
  assert.equal(schema.functions.has('messages.getBotData'), false);
  assert.equal(schema.functions.has('messages.saveGameScore'), false);
});

test('BotStore seeds a demo bot and supports bot / inline result CRUD', () => {
  const dir = tempDir();
  const store = new BotStore(dir);
  try {
    if (store.driverKind === 'sqlite') assert.ok(fs.existsSync(path.join(dir, 'bots.sqlite')));

    const seeded = store.getBot('demo_bot');
    assert.ok(seeded, 'demo bot exists');
    assert.equal(seeded.username, 'demo_bot');
    assert.equal(store.listBots().length, 1);

    const created = store.registerBot({ id: 4242n, accessHash: 99n, username: 'test_bot', token: '42:TOKEN' });
    assert.equal(created.id, 4242);
    assert.equal(store.getBot(4242n).accessHash, 99);
    assert.equal(store.getBot('@test_bot').token, '42:TOKEN');
    assert.equal(store.getBot('missing_bot'), null);
    assert.equal(store.listBots().length, 2);

    assert.deepEqual(store.getInlineResults('hello'), []);
    store.setInlineResults('hello', [{ id: 'r1', type: 'article', title: 'First' }]);
    assert.equal(store.getInlineResults('hello')[0].id, 'r1');
    store.setInlineResults('hello', [{ id: 'r2', type: 'article', title: 'Second' }, { id: 'r3' }]);
    assert.deepEqual(store.getInlineResults('hello').map((r) => r.id), ['r2', 'r3']);

    store.close();
    const reopened = new BotStore(dir);
    try {
      assert.equal(reopened.getBot('test_bot').accessHash, 99);
      assert.equal(reopened.getInlineResults('hello').length, 2);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BotStore handles scheduled messages and game scores (JSON fallback included)', () => {
  const dir = tempDir();
  const store = new BotStore(dir, { dbDriver: 'json' });
  try {
    assert.equal(store.driverKind, 'json');
    assert.ok(fs.existsSync(path.join(dir, 'bots.json')));

    const first = store.saveScheduledMessage({
      userId: 7, peerKey: 'user:42', text: 'later', scheduleDate: 2000,
    });
    const second = store.saveScheduledMessage({
      userId: 7, peerKey: 'chat:9', text: 'also later', scheduleDate: 1000,
    });
    assert.ok(first.id > 0 && second.id > first.id);
    assert.deepEqual(store.listScheduled(7).map((m) => m.id), [second.id, first.id]); // by scheduleDate
    assert.equal(store.listScheduled(8).length, 0);
    assert.equal(store.deleteScheduled(first.id), true);
    assert.equal(store.deleteScheduled(first.id), false);
    assert.deepEqual(store.listScheduled(7).map((m) => m.id), [second.id]);

    store.saveGameScore(7, 55, 10);
    store.saveGameScore(8, 55, 30);
    store.saveGameScore(9, 66, 999);
    const scores = store.getGameScores(55);
    assert.deepEqual(scores.map((s) => s.score), [30, 10]);
    assert.equal(scores[0].userId, 8);
    assert.equal(store.getGameScores(66).length, 1);

    store.close();
    const reopened = new BotStore(dir, { dbDriver: 'json' });
    try {
      assert.equal(reopened.listScheduled(7)[0].text, 'also later');
      assert.equal(reopened.getGameScores(55).length, 2);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('messages.getInlineBotResults returns messages.botResults#e021f2f6', () => {
  const dir = tempDir();
  const { botStore, ctx } = makeCtx(dir);
  try {
    const buf = B.getInlineBotResults({ bot: { id: 1000001 }, query: 'demo' }, ctx);
    const r = new TLBuffer(buf);
    assert.equal(r.uint(), B.BOT_ID.messagesBotResults);
    assert.equal(r.uint(), 0); // flags (gallery omitted)
    assert.ok(r.long() > 0n); // query_id
    const results = r.vector((rr) => {
      assert.equal(rr.uint(), B.BOT_ID.botInlineResult);
      const flags = rr.uint();
      assert.equal(rr.string(), 'demo:1');
      assert.equal(rr.string(), 'article');
      if (flags & (1 << 1)) assert.equal(rr.string(), 'Demo inline result');
      if (flags & (1 << 2)) assert.equal(rr.string(), 'A result from the seeded demo bot');
      if (flags & (1 << 3)) rr.string(); // url
      assert.equal(rr.uint(), B.BOT_ID.botInlineMessageText);
      rr.uint(); // inline message flags
      assert.equal(rr.string(), 'Hello from demo_bot');
      return true;
    });
    assert.equal(results.length, 1);
    assert.ok(r.int() > 0); // cache_time
    const users = r.vector((rr) => {
      assert.equal(rr.uint(), 0xb1b8cc83); // user
      return true;
    });
    assert.equal(users.length, 1);
    assert.equal(botStore.getInlineResults('demo').length, 1);
  } finally {
    botStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getInlineBotResults accepts a TLBuffer reader after the constructor id', () => {
  const dir = tempDir();
  const { botStore, ctx } = makeCtx(dir);
  try {
    const b = new TLBuffer();
    b.putUint(0); // flags
    b.putUint(0xf21158c6).putLong(1000001n).putLong(123n); // inputUser
    b.putUint(0xdde8a54c).putLong(42n).putLong(0n); // inputPeerUser
    b.putString('demo'); // query
    b.putString(''); // offset
    const r = new TLBuffer(B.getInlineBotResults(new TLBuffer(b.buffer), ctx));
    assert.equal(r.uint(), B.BOT_ID.messagesBotResults);
    r.uint(); // flags
    assert.ok(r.long() > 0n);
    assert.equal(r.vector(() => true).length, 1);
  } finally {
    botStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('messages.sendInlineBotResult returns updates with updateNewMessage#1f2b0afd', () => {
  const dir = tempDir();
  const { botStore, ctx, user } = makeCtx(dir);
  try {
    const buf = B.sendInlineBotResult({
      peer: { type: 'user', id: 42 }, id: 'demo:1', randomId: 7n, text: 'from inline',
    }, ctx);
    const r = new TLBuffer(buf);
    assert.equal(r.uint(), B.BOT_ID.updates);
    const updates = r.vector((rr) => {
      assert.equal(rr.uint(), B.BOT_ID.updateNewMessage);
      assert.equal(rr.uint(), B.BOT_ID.message);
      return true;
    });
    assert.equal(updates.length, 1);
    assert.equal(ctx.store.listMessages('user', 42, 1)[0].text, 'from inline');
    assert.equal(ctx.store.listMessages('user', 42, 1)[0].fromId, user.id);
  } finally {
    botStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('game score handlers return updates#74ae4240 and messages.highScores#9a3bfd99', () => {
  const dir = tempDir();
  const { botStore, ctx, user } = makeCtx(dir);
  try {
    const set = new TLBuffer(B.setGameScore({ peer: { type: 'user', id: 42 }, id: 55, userId: user.id, score: 120 }, ctx));
    assert.equal(set.uint(), B.BOT_ID.updates);
    botStore.saveGameScore(user.id, 55, 80);

    const r = new TLBuffer(B.getGameHighScores({ peer: { type: 'user', id: 42 }, id: 55 }, ctx));
    assert.equal(r.uint(), B.BOT_ID.messagesHighScores);
    const scores = r.vector((rr) => {
      assert.equal(rr.uint(), B.BOT_ID.highScore);
      assert.ok(rr.int() > 0); // pos
      assert.equal(rr.long(), BigInt(user.id));
      return rr.int(); // score
    });
    assert.deepEqual(scores, [120, 80]);
    assert.equal(botStore.getGameScores(55).length, 2);
  } finally {
    botStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduled handlers return messages.messages#1d73e7ea and updates#74ae4240', () => {
  const dir = tempDir();
  const { botStore, ctx, user } = makeCtx(dir);
  try {
    const row = botStore.saveScheduledMessage({
      userId: user.id, peerKey: 'user:42', text: 'send later', scheduleDate: 2000000000,
    });

    const list = new TLBuffer(B.getScheduledMessages({ peer: { type: 'user', id: 42 }, id: [row.id] }, ctx));
    assert.equal(list.uint(), B.BOT_ID.messagesMessages);
    assert.equal(list.uint(), 0x1cb5c415); // messages vector
    assert.equal(list.int(), 1);
    assert.equal(list.uint(), B.BOT_ID.message);
    const flags = list.uint();
    assert.ok(flags & (1 << 1)); // out
    assert.ok(flags & (1 << 18)); // from_scheduled
    assert.equal(list.uint(), B.BOT_ID.boolTrue); // out:true
    assert.equal(list.uint(), B.BOT_ID.boolTrue); // from_scheduled:true
    list.uint(); // flags2
    assert.equal(list.int(), row.id);
    assert.equal(list.uint(), B.BOT_ID.peerUser);
    assert.equal(list.long(), 42n);
    list.int(); // date
    assert.equal(list.string(), 'send later');

    const sent = new TLBuffer(B.sendScheduledMessages({ peer: { type: 'user', id: 42 }, id: [row.id] }, ctx));
    assert.equal(sent.uint(), B.BOT_ID.updates);
    const updates = sent.vector((rr) => {
      assert.equal(rr.uint(), B.BOT_ID.updateNewMessage);
      return true;
    });
    assert.equal(updates.length, 1);
    assert.equal(botStore.listScheduled(user.id).length, 0);
    assert.equal(ctx.store.listMessages('user', 42, 1)[0].text, 'send later');

    const next = botStore.saveScheduledMessage({
      userId: user.id, peerKey: 'user:42', text: 'delete me', scheduleDate: 2000000000,
    });
    const deleted = new TLBuffer(B.deleteScheduledMessages({ peer: { type: 'user', id: 42 }, id: [next.id] }, ctx));
    assert.equal(deleted.uint(), B.BOT_ID.updates);
    assert.equal(deleted.vector((rr) => {
      assert.equal(rr.uint(), B.BOT_ID.updateDeleteMessages);
      return true;
    }).length, 1);
    assert.equal(botStore.listScheduled(user.id).length, 0);
  } finally {
    botStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bots.* handlers return their verified layer-234 constructor ids', () => {
  const dir = tempDir();
  const { botStore, ctx } = makeCtx(dir);
  try {
    const info = new TLBuffer(B.getBotInfo({ bot: { id: 1000001 } }, ctx));
    assert.equal(info.uint(), B.BOT_ID.botsBotInfo);
    assert.equal(info.string(), 'demo_bot');
    assert.equal(info.string(), 'Bot @demo_bot');
    assert.equal(info.string(), '');

    assert.equal(B.setBotInfo({ bot: { id: 1000001 }, about: 'hi' }, ctx).readUInt32LE(0), B.BOT_ID.boolTrue);
    assert.equal(B.canSendMessage({ bot: { id: 1000001 } }, ctx).readUInt32LE(0), B.BOT_ID.boolTrue);
    assert.equal(B.checkUsername({ username: 'demo_bot' }, ctx).readUInt32LE(0), B.BOT_ID.boolFalse);
    assert.equal(B.checkUsername({ username: 'free_name' }, ctx).readUInt32LE(0), B.BOT_ID.boolTrue);
    assert.equal(B.setBotCommands({ commands: [] }, ctx).readUInt32LE(0), B.BOT_ID.boolTrue);

    const commands = new TLBuffer(B.getBotCommands({ commands: [{ command: 'start', description: 'Begin' }] }, ctx));
    assert.equal(commands.uint(), B.BOT_ID.vector);
    assert.equal(commands.int(), 1);
    assert.equal(commands.uint(), B.BOT_ID.botCommand);
    commands.uint(); // flags
    assert.equal(commands.string(), 'start');
    assert.equal(commands.string(), 'Begin');

    const menu = new TLBuffer(B.getBotMenuButton({ bot: { id: 1000001 } }, ctx));
    assert.equal(menu.uint(), B.BOT_ID.botMenuButtonDefault);

    const bots = new TLBuffer(B.getAdminedBots({}, ctx));
    assert.equal(bots.uint(), B.BOT_ID.vector);
    assert.equal(bots.int(), 1);
    assert.equal(bots.uint(), 0xb1b8cc83); // user
  } finally {
    botStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
