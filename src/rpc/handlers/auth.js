import crypto from 'node:crypto';
import * as C from './codecs.js';
import { int, str, isReader, skipCodeSettings } from './parsers.js';
import { authKeyIdOf, ensureSession, configOf } from './context.js';

function error(code, message) {
  return C.rpcError({ code, message });
}

export function sendCode(r, ctx) {
  const phone = str(r, 'phoneNumber', '');
  int(r, 'apiId', 0); // api_id
  str(r, 'apiHash', ''); // api_hash
  skipCodeSettings(r);

  const store = ctx.store;
  const code = configOf(ctx).authCode || '22222';
  const hash = crypto.randomBytes(12).toString('hex');
  store.createCode(phone, code, hash);
  return C.sentCode({ phoneCodeHash: hash, length: String(code).length, type: 'sms' });
}

export function signIn(r, ctx) {
  const flags = int(r, 'flags', 0);
  const phone = str(r, 'phoneNumber', '');
  const hash = str(r, 'phoneCodeHash', '');
  const fallbackCode = configOf(ctx).authCode || '22222';
  const code = (flags & 1)
    ? str(r, 'phoneCode', '')
    : (isReader(r) ? fallbackCode : str(r, 'phoneCode', fallbackCode));
  const store = ctx.store;

  if (!store.checkCode(phone, hash, code)) {
    return error(400, 'PHONE_CODE_INVALID');
  }

  let user = store.getUserByPhone(phone);
  if (!user) user = store.createUser({ phone, firstName: '', lastName: '' });
  const session = ensureSession(store, ctx, user.id);
  ctx.userId = user.id;
  ctx.session = session;
  return C.authorization({ ...user, self: true });
}

export function signUp(r, ctx) {
  const flags = int(r, 'flags', 0);
  const phone = str(r, 'phoneNumber', '');
  const hash = str(r, 'phoneCodeHash', '');
  let firstName;
  let lastName;
  if (flags & 1) {
    // no_joined_notifications:flags.0?true (only affects flags, no extra data)
  }
  firstName = str(r, 'firstName', '');
  lastName = str(r, 'lastName', '');
  const store = ctx.store;

  if (!store.checkCode(phone, hash, configOf(ctx).authCode || '22222')) {
    return error(400, 'PHONE_CODE_INVALID');
  }

  let user = store.getUserByPhone(phone);
  if (user) {
    // Re-registration: keep the id but refresh the profile.
    user = { ...user, firstName, lastName };
  } else {
    user = store.createUser({ phone, firstName, lastName });
  }
  const session = ensureSession(store, ctx, user.id);
  ctx.userId = user.id;
  ctx.session = session;
  return C.authorization({ ...user, self: true });
}

export default { sendCode, signIn, signUp };
