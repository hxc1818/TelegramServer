// Shared helpers for resolving the "current" user/session inside a handler.
export function authKeyIdOf(ctx = {}) {
  return ctx.authKeyId ?? ctx.session?.authKeyId ?? ctx.session?.auth_key_id ?? ctx.server?.authKeyId ?? '';
}

export function currentUser(store, ctx = {}) {
  if (ctx.user && ctx.user.id) return ctx.user;
  if (ctx.userId) return store.getUser(ctx.userId) || null;
  if (ctx.session?.userId) return store.getUser(ctx.session.userId) || null;
  const authKeyId = authKeyIdOf(ctx);
  if (authKeyId) {
    const session = store.getSession(authKeyId);
    if (session?.userId) {
      const user = store.getUser(session.userId);
      if (user) return user;
    }
  }
  // Local single-user server: fall back to the first registered account.
  const first = store.driver?.all?.('users', {}, { limit: 1 })?.[0];
  return first ? store.getUser(first.id) : null;
}

export function ensureSession(store, ctx = {}, userId) {
  let id = authKeyIdOf(ctx);
  if (!id) {
    id = `local:${userId}`;
  }
  return store.createSession(userId, id);
}

export function configOf(ctx = {}) {
  return ctx.config || {};
}
