// Help / langpack store and RPC handler tests (no network involved).
// Constructor and method ids are checked against the pinned schema/api.tl (layer 234).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { loadSchema } from '../src/tl/schema.js';
import { HelpStore } from '../src/store/help.js';
import * as H from '../src/rpc/handlers/help-extra.js';

function tempDir(tag = 'help-extra') {
  const dir = path.join(os.tmpdir(), `telegramserver-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function firstId(buf) {
  assert.ok(Buffer.isBuffer(buf), 'handler must return a Buffer');
  return new TLBuffer(buf).uint();
}

function makeCtx(dir) {
  return { helpStore: new HelpStore(dir), config: { dataDir: dir } };
}

test('every help/langpack constructor and method id matches schema/api.tl (layer 234)', () => {
  const schema = loadSchema();
  assert.equal(schema.layer, 234);

  const types = {
    vector: 'vector', boolTrue: 'boolTrue',
    peerUser: 'peerUser', peerChat: 'peerChat', peerChannel: 'peerChannel',
    userEmpty: 'userEmpty', chatEmpty: 'chatEmpty', dataJSON: 'dataJSON',
    cdnPublicKey: 'cdnPublicKey', cdnConfig: 'cdnConfig',
    inviteText: 'help.inviteText', support: 'help.support',
    termsOfService: 'help.termsOfService',
    termsOfServiceUpdate: 'help.termsOfServiceUpdate',
    termsOfServiceUpdateEmpty: 'help.termsOfServiceUpdateEmpty',
    countriesList: 'help.countriesList',
    countriesListNotModified: 'help.countriesListNotModified',
    country: 'help.country', countryCode: 'help.countryCode',
    appUpdate: 'help.appUpdate', noAppUpdate: 'help.noAppUpdate',
    promoData: 'help.promoData', promoDataEmpty: 'help.promoDataEmpty',
    pendingSuggestion: 'pendingSuggestion', textWithEntities: 'textWithEntities',
    passportConfig: 'help.passportConfig',
    passportConfigNotModified: 'help.passportConfigNotModified',
    langPackLanguage: 'langPackLanguage', langPackString: 'langPackString',
    langPackStringDeleted: 'langPackStringDeleted',
    langPackDifference: 'langPackDifference',
  };
  for (const [key, name] of Object.entries(types)) {
    const entry = schema.types.get(name);
    assert.ok(entry, `schema missing type ${name}`);
    assert.equal(H.ID[key], entry.id, `${key} != ${name}`);
  }
  for (const [name, id] of Object.entries(H.METHOD_IDS)) {
    const entry = schema.functions.get(name);
    assert.ok(entry, `schema missing function ${name}`);
    assert.equal(id, entry.id, `${name} id mismatch`);
  }
  // Non-schema aliases still resolve to grep-verified method ids.
  assert.equal(H.METHOD_IDS['help.getTermsOfService'], 0x2ca51fd1);
  assert.equal(H.METHOD_IDS['help.getProxyData'], 0xc0977421);
  assert.equal(H.METHOD_IDS['help.getPromoInfo'], 0xc0977421);
});

test('HelpStore seeds defaults and supports config/country/lang/string CRUD with persistence', () => {
  const dir = tempDir('help-store');
  try {
    const store = new HelpStore(dir);
    try {
      if (store.driverKind === 'sqlite') assert.ok(fs.existsSync(path.join(dir, 'help.sqlite')));

      // config overrides
      assert.equal(store.getConfigOverride('missing'), undefined);
      store.setConfigOverride('answer', 42);
      store.setConfigOverride('note', 'hello');
      store.setConfigOverride('json', { a: 1 });
      assert.equal(store.getConfigOverride('answer'), 42);
      assert.equal(store.getConfigOverride('note'), 'hello');
      assert.deepEqual(store.getConfigOverride('json'), { a: 1 });

      // sensible defaults
      assert.ok(store.getInviteText().length > 0);
      assert.ok(store.getSupport().phoneNumber);
      assert.equal(store.getTerms().text, '');
      assert.deepEqual(store.getCdnConfig().publicKeys, []);
      assert.equal(store.getAppUpdate(), null);
      assert.equal(store.getLanguages().some((l) => l.langCode === 'en'), true);
      assert.equal(store.getLanguage('en').name, 'English');
      assert.equal(store.getStrings('en', ['ok'])[0].value, 'OK');
      assert.equal(store.getStrings('en', ['nope'])[0].deleted, true);
      assert.equal(store.getDifference('en', 0).version, 1);
      assert.equal(store.getDifference('en', 0).strings.length, 3);
      assert.equal(store.getDifference('en', 1).strings.length, 0);

      // countries
      assert.equal(store.listCountries().some((c) => c.iso2 === 'US'), true);
      const cn = store.setCountry({ iso2: 'cn', defaultName: 'China', countryCodes: [{ countryCode: '86' }] });
      assert.equal(cn.iso2, 'CN');
      assert.equal(store.listCountries().some((c) => c.iso2 === 'CN'), true);
      store.setCountry({ iso2: 'CN', defaultName: 'China', name: '中国' });
      assert.equal(store.listCountries().find((c) => c.iso2 === 'CN').name, '中国');

      // languages & strings
      store.setLanguage({ langCode: 'FR', name: 'French', nativeName: 'Français', baseLangCode: 'en', version: 2 });
      assert.equal(store.getLanguage('fr').baseLangCode, 'en');
      store.setString('fr', 'ok', 'Oui');
      assert.equal(store.getStrings('fr', ['ok'])[0].value, 'Oui');
      assert.equal(store.deleteString('fr', 'ok'), true);
      assert.equal(store.getStrings('fr', ['ok'])[0].deleted, true);

      // help settings
      store.setInviteText('Join now');
      store.setSupport({ phoneNumber: '+123', userId: 7 });
      store.setTerms({ expires: 100, text: 'Rules', popup: true, minAgeConfirm: 18 });
      store.setCdnConfig({ publicKeys: [{ dcId: 1, publicKey: 'pkey' }] });
      store.setAppUpdate({ id: 5, version: '2.0', text: 'new' });
      assert.equal(store.getInviteText(), 'Join now');
      assert.equal(store.getSupport().userId, 7);
      assert.equal(store.getTerms().minAgeConfirm, 18);
      assert.equal(store.getCdnConfig().publicKeys[0].publicKey, 'pkey');
      assert.equal(store.getAppUpdate().id, 5);
    } finally {
      store.close();
    }

    const reopened = new HelpStore(dir);
    try {
      assert.equal(reopened.getConfigOverride('answer'), 42);
      assert.deepEqual(reopened.getConfigOverride('json'), { a: 1 });
      assert.equal(reopened.getInviteText(), 'Join now');
      assert.equal(reopened.listCountries().find((c) => c.iso2 === 'CN').name, '中国');
      assert.equal(reopened.getLanguage('fr').version, 2);
      assert.equal(reopened.getAppUpdate().version, '2.0');
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const jsonDir = tempDir('help-json');
  try {
    const store = new HelpStore(jsonDir, { dbDriver: 'json' });
    store.setConfigOverride('mode', 'json');
    store.close();
    assert.ok(fs.existsSync(path.join(jsonDir, 'help.json')));
    const reopened = new HelpStore(jsonDir, { dbDriver: 'json' });
    assert.equal(reopened.getConfigOverride('mode'), 'json');
    assert.equal(reopened.getLanguage('en').langCode, 'en');
    reopened.close();
  } finally {
    fs.rmSync(jsonDir, { recursive: true, force: true });
  }
});

test('handlers return schema-declared constructors (plain object params)', () => {
  const dir = tempDir('help-handlers');
  const ctx = makeCtx(dir);
  try {
    const cases = [
      ['getCdnConfig', {}, H.ID.cdnConfig],
      ['getInviteText', {}, H.ID.inviteText],
      ['getSupport', {}, H.ID.support],
      ['getTermsOfService', {}, H.ID.termsOfServiceUpdateEmpty],
      ['getTermsOfServiceUpdate', {}, H.ID.termsOfServiceUpdateEmpty],
      ['getCountriesList', { langCode: 'en', hash: 0 }, H.ID.countriesList],
      ['getAppUpdate', { source: 'test' }, H.ID.noAppUpdate],
      ['getPromoData', {}, H.ID.promoDataEmpty],
      ['getProxyData', {}, H.ID.promoDataEmpty],
      ['getPromoInfo', {}, H.ID.promoDataEmpty],
      ['getPassportConfig', { hash: 0 }, H.ID.passportConfig],
      ['getLanguages', { langPack: '' }, H.ID.vector],
      ['getLanguage', { langPack: '', langCode: 'en' }, H.ID.langPackLanguage],
      ['getStrings', { langPack: '', langCode: 'en', keys: ['ok'] }, H.ID.vector],
      ['getDifference', { langPack: '', langCode: 'en', fromVersion: 0 }, H.ID.langPackDifference],
      ['getLangPack', { langPack: '', langCode: 'en' }, H.ID.langPackDifference],
    ];
    for (const [name, params, id] of cases) {
      assert.equal(firstId(H[name](params, ctx)), id, `${name} returned a wrong constructor`);
    }
  } finally {
    ctx.helpStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handlers accept a TLBuffer reader positioned after the method id', () => {
  const dir = tempDir('help-reader');
  const ctx = makeCtx(dir);
  try {
    const req = new TLBuffer()
      .putUint(H.METHOD_IDS['langpack.getStrings'])
      .putString('')
      .putString('en')
      .putVector(['ok', 'missing'], (s, b) => b.putString(s))
      .buffer;
    const r = new TLBuffer(req);
    assert.equal(r.uint(), H.METHOD_IDS['langpack.getStrings']);
    const out = new TLBuffer(H.getStrings(r, ctx));
    assert.equal(out.uint(), H.ID.vector);
    assert.equal(out.int(), 2);
    assert.equal(out.uint(), H.ID.langPackString);
    assert.equal(out.string(), 'ok');
    assert.equal(out.string(), 'OK');
    assert.equal(out.uint(), H.ID.langPackStringDeleted);
    assert.equal(out.string(), 'missing');

    const diffReq = new TLBuffer()
      .putUint(H.METHOD_IDS['langpack.getDifference'])
      .putString('')
      .putString('en')
      .putInt(0)
      .buffer;
    const dr = new TLBuffer(diffReq);
    dr.uint();
    const diff = new TLBuffer(H.getDifference(dr, ctx));
    assert.equal(diff.uint(), H.ID.langPackDifference);
    assert.equal(diff.string(), 'en');
    assert.equal(diff.int(), 0);
    assert.equal(diff.int(), 1);
    assert.equal(diff.uint(), H.ID.vector);
  } finally {
    ctx.helpStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('countriesList encodes typed countries and honours the hash', () => {
  const dir = tempDir('help-countries');
  const ctx = makeCtx(dir);
  try {
    const first = new TLBuffer(H.getCountriesList({ langCode: 'en', hash: 0 }, ctx));
    assert.equal(first.uint(), H.ID.countriesList);
    assert.equal(first.uint(), H.ID.vector);
    const count = first.int();
    assert.ok(count >= 1);
    assert.equal(first.uint(), H.ID.country);
    const flags = first.uint();
    assert.equal(flags & 1, 0);
    const iso2 = first.string();
    assert.ok(iso2);
    first.string(); // default_name
    if (flags & 2) first.string();
    assert.equal(first.uint(), H.ID.vector); // country_codes
    const codeCount = first.int();
    for (let i = 0; i < codeCount; i++) {
      assert.equal(first.uint(), H.ID.countryCode);
      const codeFlags = first.uint();
      first.string(); // country_code
      if (codeFlags & 1) {
        assert.equal(first.uint(), H.ID.vector);
        const n = first.int();
        for (let j = 0; j < n; j++) first.string();
      }
      if (codeFlags & 2) {
        assert.equal(first.uint(), H.ID.vector);
        const n = first.int();
        for (let j = 0; j < n; j++) first.string();
      }
    }
    const hash = first.int();
    assert.notEqual(hash, 0);

    assert.equal(firstId(H.getCountriesList({ langCode: 'en', hash }, ctx)), H.ID.countriesListNotModified);
  } finally {
    ctx.helpStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appUpdate, termsOfServiceUpdate and langPackLanguage use correct flags/vectors', () => {
  const dir = tempDir('help-flags');
  const ctx = makeCtx(dir);
  try {
    ctx.helpStore.setAppUpdate({
      id: 7, version: '2.0', text: 'Upgrade', canNotSkip: true,
      entities: [{ type: 'bold', offset: 0, length: 3 }],
    });
    const upd = new TLBuffer(H.getAppUpdate({ source: 'desktop' }, ctx));
    assert.equal(upd.uint(), H.ID.appUpdate);
    const flags = upd.uint();
    assert.equal(flags & 1, 1);
    assert.equal(flags & 2, 0);
    assert.equal(upd.uint(), H.ID.boolTrue); // can_not_skip
    assert.equal(upd.int(), 7);
    assert.equal(upd.string(), '2.0');
    assert.equal(upd.string(), 'Upgrade');
    assert.equal(upd.uint(), H.ID.vector);
    assert.equal(upd.int(), 1);
    assert.equal(upd.uint(), 0xbd610bc9); // messageEntityBold
    assert.equal(upd.int(), 0);
    assert.equal(upd.int(), 3);

    ctx.helpStore.setTerms({ expires: 123, text: 'Terms', id: 'v1', popup: true, minAgeConfirm: 18 });
    const terms = new TLBuffer(H.getTermsOfService({}, ctx));
    assert.equal(terms.uint(), H.ID.termsOfServiceUpdate);
    assert.equal(terms.int(), 123);
    assert.equal(terms.uint(), H.ID.termsOfService);
    assert.equal(terms.uint(), 3); // popup + min_age_confirm
    assert.equal(terms.uint(), H.ID.boolTrue);
    assert.equal(terms.uint(), H.ID.dataJSON);
    assert.equal(terms.string(), 'v1');
    assert.equal(terms.string(), 'Terms');
    assert.equal(terms.uint(), H.ID.vector);
    assert.equal(terms.int(), 0); // entities
    assert.equal(terms.int(), 18); // min_age_confirm

    ctx.helpStore.setLanguage({
      langCode: 'fr', name: 'French', nativeName: 'Français', baseLangCode: 'en',
      pluralCode: 'fr', official: true, rtl: false, beta: false,
      stringsCount: 2, translatedCount: 1, translationsUrl: '', version: 2,
    });
    const lang = new TLBuffer(H.getLanguage({ langPack: '', langCode: 'fr' }, ctx));
    assert.equal(lang.uint(), H.ID.langPackLanguage);
    assert.equal(lang.uint(), 3); // official + base_lang_code
    assert.equal(lang.uint(), H.ID.boolTrue);
    assert.equal(lang.string(), 'French');
    assert.equal(lang.string(), 'Français');
    assert.equal(lang.string(), 'fr');
    assert.equal(lang.string(), 'en');
    assert.equal(lang.string(), 'fr');
    assert.equal(lang.int(), 2);
    assert.equal(lang.int(), 1);
  } finally {
    ctx.helpStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
