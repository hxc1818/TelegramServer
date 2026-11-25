// Real push delivery over an HTTP(S) webhook, plus provider adapter helpers.
//
// The webhook path is fully functional: it signs every payload with HMAC-SHA256
// and POSTs JSON with a timeout and bounded retries. Set PUSH_WEBHOOK_URL (or
// pass `endpoint`) to a receiver you control. The APNs/FCM adapters below only
// *format* provider payloads; real APNs/FCM delivery additionally requires user
// credentials (an APNs .p8 signing key / team id / topic, or an FCM server key
// / service account). Those credentials are not bundled with this server, so
// provider delivery is blocked until you supply them yourself.

import crypto from 'node:crypto';

const defaultSleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (typeof timer?.unref === 'function') timer.unref();
});

const toNumber = (v, fallback = 0) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function now() {
  return Math.floor(Date.now() / 1000);
}

function devicePayload(device = {}) {
  const appId = String(device.appId ?? device.app_id ?? '');
  return {
    token: String(device.token ?? ''),
    type: device.type ?? '',
    app_id: appId,
  };
}

/** APNs adapter: formats an `aps` payload; credentials come from options.
 *
 *  options: { teamId, keyId, privateKey (P8 PEM), topic|bundleId,
 *             production = false, fetchImpl }
 *
 *  Real APNs delivery needs those credentials and an HTTP/2 provider client;
 *  neither is bundled here. Without credentials `send()` throws immediately.
 */
export function createAPNsAdapter(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const credentials = {
    teamId: String(opts.teamId ?? opts.team_id ?? ''),
    keyId: String(opts.keyId ?? opts.key_id ?? ''),
    privateKey: String(opts.privateKey ?? opts.private_key ?? ''),
    topic: String(opts.topic ?? opts.bundleId ?? opts.bundle_id ?? ''),
    production: Boolean(opts.production),
  };
  const configured = Boolean(credentials.teamId && credentials.keyId
    && credentials.privateKey && credentials.topic);

  return {
    provider: 'apns',
    configured,
    credentials,
    /** Build the JSON body sent to APNs (the `aps` key is mandatory). */
    format({ text = '', title = 'Telegram', devices = [], badge, sound = 'default', data = {} } = {}) {
      const aps = { alert: { title: String(title), body: String(text) }, sound };
      if (badge !== undefined) aps.badge = toNumber(badge);
      return {
        aps,
        device_tokens: (Array.isArray(devices) ? devices : [devices]).map((d) => String(typeof d === 'string' ? d : d?.token ?? '')),
        ...data,
      };
    },
    /** Provider delivery is unavailable without user-supplied credentials. */
    async send(notification, devices = []) {
      if (!configured) {
        throw new Error('APNs delivery blocked: supply teamId, keyId, privateKey (P8) and topic/bundleId in adapter options');
      }
      throw new Error('APNs delivery requires an HTTP/2 provider client; configure one with options.transport');
    },
  };
}

/** FCM adapter: formats a `notification` payload; credentials come from options.
 *
 *  options: { serverKey|apiKey|serviceAccount, projectId, fetchImpl }
 *
 *  Real FCM delivery requires your own Firebase credentials. `send()` throws
 *  until they are provided; the webhook path has no such requirement.
 */
export function createFCMAdapter(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const credentials = {
    serverKey: String(opts.serverKey ?? opts.server_key ?? opts.apiKey ?? opts.api_key ?? ''),
    projectId: String(opts.projectId ?? opts.project_id ?? ''),
    serviceAccount: opts.serviceAccount ?? opts.service_account ?? null,
  };
  const configured = Boolean(credentials.serverKey || credentials.serviceAccount);

  return {
    provider: 'fcm',
    configured,
    credentials,
    /** Build the JSON body sent to FCM (the `notification` key is mandatory). */
    format({ text = '', title = 'Telegram', devices = [], data = {}, priority = 'high' } = {}) {
      const tokens = (Array.isArray(devices) ? devices : [devices])
        .map((d) => String(typeof d === 'string' ? d : d?.token ?? ''));
      const body = { notification: { title: String(title), body: String(text) }, priority };
      if (tokens.length === 1) body.to = tokens[0];
      else if (tokens.length) body.registration_ids = tokens;
      if (data && Object.keys(data).length) body.data = data;
      return body;
    },
    async send(notification, devices = []) {
      if (!configured) {
        throw new Error('FCM delivery blocked: supply serverKey (legacy) or serviceAccount credentials in adapter options');
      }
      throw new Error('FCM delivery requires a configured transport; supply one with options.fetchImpl/transport');
    },
  };
}

export class PushDispatcher {
  /**
   * @param {object}   options
   * @param {object}   options.store      PushStore instance (device + queue state)
   * @param {string}   options.endpoint   HTTP(S) webhook URL; defaults to PUSH_WEBHOOK_URL
   * @param {string}   options.hmacSecret secret for createHmac('sha256', secret)
   * @param {number}   options.timeoutMs  per-request timeout (default 5000)
   * @param {Function} options.fetchImpl  fetch-compatible function (default: global fetch)
   * @param {Function} options.sleep      injectable backoff sleep(ms) for tests
   * @param {number}   options.retries    max attempts, default 3
   */
  constructor({
    store = null,
    endpoint,
    hmacSecret,
    timeoutMs = 5000,
    fetchImpl,
    sleep,
    retries,
  } = {}) {
    this.store = store;
    this.endpoint = String(endpoint ?? process.env.PUSH_WEBHOOK_URL ?? '');
    this.hmacSecret = hmacSecret === undefined || hmacSecret === null
      ? String(process.env.PUSH_HMAC_SECRET ?? '') : String(hmacSecret);
    this.timeoutMs = toNumber(timeoutMs, 5000) || 5000;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.sleep = typeof sleep === 'function' ? sleep : defaultSleep;
    this.maxRetries = Math.max(1, toNumber(retries, 3) || 3);
    this._controllers = new Set();
    this.closed = false;
  }

  /** Build the signed body. The HMAC covers every key except `hmac` itself. */
  buildPayload(userId, notification = {}) {
    const devices = notification.devices
      || (this.store ? this.store.getDevicesForUsers([userId]) : []);
    const body = {
      user_id: toNumber(userId),
      peer_key: String(notification.peerKey ?? notification.peer_key ?? ''),
      text: String(notification.text ?? ''),
      date: toNumber(notification.date, now()),
      devices: (Array.isArray(devices) ? devices : [devices]).map(devicePayload),
    };
    const hmac = crypto.createHmac('sha256', this.hmacSecret)
      .update(JSON.stringify(body)).digest('hex');
    return { ...body, hmac };
  }

  /**
   * POST the signed payload to the webhook. Retries transient failures up to
   * `maxRetries` times with exponential backoff (driven by this.sleep).
   * @returns {Promise<{ok:boolean, status:number, attempts:number, payload:object, error?:string}>}
   */
  async dispatch(userId, notification = {}) {
    if (this.closed) {
      return { ok: false, status: 0, attempts: 0, error: 'dispatcher closed' };
    }
    if (!this.endpoint || typeof this.fetchImpl !== 'function') {
      return {
        ok: false,
        status: 0,
        attempts: 0,
        error: this.endpoint ? 'no fetch implementation available' : 'no webhook endpoint configured (set PUSH_WEBHOOK_URL)',
      };
    }

    const payload = this.buildPayload(userId, notification);
    const rawBody = JSON.stringify(payload);
    let status = 0;
    let lastError = '';
    let ok = false;
    let attempts = 0;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      attempts = attempt;
      const controller = new AbortController();
      this._controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      if (typeof timer?.unref === 'function') timer.unref();
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': `sha256=${payload.hmac}`,
          },
          body: rawBody,
          signal: controller.signal,
        });
        status = toNumber(response?.status ?? response?.statusCode, 0);
        ok = status >= 200 && status < 300;
        if (ok) break;
        lastError = `webhook returned HTTP ${status}`;
      } catch (err) {
        lastError = String(err?.message ?? err);
      } finally {
        clearTimeout(timer);
        this._controllers.delete(controller);
      }
      if (!ok && attempt < this.maxRetries) {
        await this.sleep(100 * (2 ** (attempt - 1)));
      }
    }

    return { ok, status, attempts, payload, error: ok ? undefined : lastError };
  }

  /** Drain the store's undelivered queue; mark rows delivered only on 2xx. */
  async flushPending({ limit = 100 } = {}) {
    if (!this.store) return { total: 0, delivered: 0, failed: 0 };
    const pending = this.store.listUndelivered(limit);
    let delivered = 0;
    let failed = 0;
    for (const notification of pending) {
      const result = await this.dispatch(notification.userId, notification);
      if (result.ok) {
        if (this.store.markDelivered(notification.id)) delivered++;
      } else {
        failed++;
      }
    }
    return { total: pending.length, delivered, failed };
  }

  /**
   * Called for a new incoming message. Resolves recipient devices through the
   * PushStore, queues a notification, and attempts immediate delivery. Failed
   * attempts stay in the queue for a later `flushPending()`.
   */
  async onNewMessage(message = {}) {
    const {
      fromId = 0,
      peerKey = 'users',
      text = '',
      date,
      userId,
      toId,
      recipientId,
      recipientIds,
      devices,
    } = message;
    const recipients = this._resolveRecipients({ fromId, peerKey, userId, toId, recipientId, recipientIds });
    const results = [];
    for (const id of recipients) {
      const byRecipient = devices && !Array.isArray(devices) ? devices[id] : null;
      const flatDevices = Array.isArray(devices) ? devices : null;
      const recipientDevices = byRecipient || flatDevices
        || (this.store ? this.store.getDevicesForUsers([id]) : []);
      if (!recipientDevices.length) continue;
      const notification = this.store
        ? this.store.enqueueNotification({ userId: id, peerKey, text, date })
        : { userId: id, peerKey, text, date: date ?? now(), devices: recipientDevices };
      const result = await this.dispatch(id, { ...notification, devices: recipientDevices });
      if (result.ok && this.store) this.store.markDelivered(notification.id);
      results.push({ userId: id, notification, ...result });
    }
    return results;
  }

  _resolveRecipients({ fromId, peerKey, userId, toId, recipientId, recipientIds } = {}) {
    const explicit = [userId, toId, recipientId];
    if (Array.isArray(recipientIds) && recipientIds.length) {
      return [...new Set(recipientIds.map((v) => toNumber(v)).filter(Boolean))];
    }
    const ids = explicit.filter((v) => v !== undefined && v !== null)
      .map((v) => toNumber(v)).filter(Boolean);
    if (ids.length) return [...new Set(ids)];
    const key = String(peerKey ?? '');
    const match = key.match(/^(?:user|chat|channel|secret):(\d+)$/) || key.match(/^(\d+)$/);
    if (match) return [Number(match[1])].filter(Boolean);
    // Group/global peer keys have no member list in PushStore. Fall back to
    // every registered user except the sender (best effort for a local server).
    if (this.store && typeof this.store.listDeviceUserIds === 'function') {
      return this.store.listDeviceUserIds().filter((id) => id !== toNumber(fromId));
    }
    return [];
  }

  /** Abort any in-flight requests; subsequent dispatch calls fail fast. */
  close() {
    this.closed = true;
    for (const controller of this._controllers) {
      try { controller.abort(); } catch { /* already settled */ }
    }
    this._controllers.clear();
  }
}

export default PushDispatcher;
