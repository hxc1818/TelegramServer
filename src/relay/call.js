// Call relay: signaling fan-out plus a plain UDP media relay.
//
// MEDIA NOTE: RTP payloads are relayed OPAQUE. This module does NOT perform
// SRTP encryption/decryption, does NOT derive or exchange keys, and does NOT
// implement ICE/STUN/TURN. It only forwards UDP datagrams between the peers
// registered for a call, keyed by "address:port". Endpoints remain responsible
// for their own SRTP keys and for any DTLS/SDP negotiation.
//
// Zero npm dependencies; uses only node:dgram.

import dgram from 'node:dgram';

const keyOf = (value) => {
  if (value === undefined || value === null) return '0';
  return typeof value === 'bigint' ? value.toString(10) : String(value);
};

const peerKeyOf = (address, port) => `${address || '0.0.0.0'}:${Number(port) || 0}`;

function normalizePeer(value) {
  if (value === undefined || value === null) return null;
  const out = {};
  if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) {
    Object.assign(out, value);
    out.userId = value.userId ?? value.user_id ?? value.id ?? value.peerId ?? value.user_id ?? 0;
    out.address = value.address ?? value.host ?? value.ip ?? null;
    out.port = Number(value.port ?? 0) || 0;
  } else {
    out.userId = value;
    out.address = null;
    out.port = 0;
  }
  out.key = keyOf(out.userId);
  return out;
}

/**
 * In-memory call relay.
 *
 * @param {{callStore?: object}} [options] optional CallStore; when registerCall
 *   is invoked without peers, caller/callee ids are loaded from this store.
 */
export class CallRelay {
  constructor(options = {}) {
    this.options = options || {};
    this.callStore = this.options.callStore || null;

    /** callId key -> Map<userId key, peer record> (signaling membership). */
    this.calls = new Map();
    /** callId key -> Map<address:port, peer record> (media membership). */
    this.media = new Map();
    /** address:port -> Set<callId key> (reverse index for incoming datagrams). */
    this.mediaIndex = new Map();

    this.socket = null;
    this.mediaAddress = null;
    this.ready = null;
    this.lastError = null;

    this.stats = {
      signalingMessages: 0,
      signalingRecipients: 0,
      packetsReceived: 0,
      packetsForwarded: 0,
      packetsDropped: 0,
      socketErrors: 0,
      relaysStarted: 0,
      relaysStopped: 0,
    };
  }

  // ---- signaling --------------------------------------------------------

  /** Register (or replace) the user ids belonging to a call. */
  registerCall(callId, peers = []) {
    const callKey = keyOf(callId);
    let list = Array.isArray(peers) ? peers.slice() : [peers];

    if (!list.length && this.callStore?.getCall) {
      const stored = this.callStore.getCall(callId);
      if (stored) {
        if (stored.callerId !== undefined && stored.callerId !== null) list.push({ userId: stored.callerId });
        if (stored.calleeId !== undefined && stored.calleeId !== null) list.push({ userId: stored.calleeId });
      }
    }

    // A re-registration replaces the previous membership entirely.
    this._clearMediaForCall(callKey);
    const members = new Map();
    for (const raw of list) {
      const peer = normalizePeer(raw);
      if (!peer) continue;
      members.set(peer.key, peer);
      if (peer.address && peer.port) this._addMediaPeer(callKey, peer);
    }
    this.calls.set(callKey, members);
    return this.getPeers(callId);
  }

  /** Remove a call from both the signaling and media routing tables. */
  unregisterCall(callId) {
    const callKey = keyOf(callId);
    this._clearMediaForCall(callKey);
    return this.calls.delete(callKey);
  }

  /**
   * Deliver an opaque signaling blob to every other member of the call.
   * @returns {Array} recipient user ids (in registration order, sender omitted)
   */
  relaySignaling(callId, fromUserId, data) {
    const members = this.calls.get(keyOf(callId));
    if (!members) return [];
    const fromKey = keyOf(fromUserId);
    const recipients = [];
    for (const [key, peer] of members) {
      if (key !== fromKey) recipients.push(peer.userId);
    }
    this.stats.signalingMessages += 1;
    this.stats.signalingRecipients += recipients.length;
    void data; // signaling blobs are opaque to the relay
    return recipients;
  }

  /** Snapshot of the signaling peers of a call. */
  getPeers(callId) {
    const members = this.calls.get(keyOf(callId));
    return members ? [...members.values()].map((p) => ({ ...p })) : [];
  }

  // ---- UDP media relay --------------------------------------------------

  /** Register a UDP peer (address:port) for media forwarding. */
  registerMediaPeer(callId, peer) {
    const normalized = normalizePeer(peer);
    if (!normalized?.address || !normalized.port) return null;
    this._addMediaPeer(keyOf(callId), normalized);
    return { ...normalized };
  }

  /** Remove one address:port peer from a call's media routing table. */
  unregisterMediaPeer(callId, address, port) {
    const callKey = keyOf(callId);
    const peerKey = peerKeyOf(address, port);
    const bucket = this.media.get(callKey);
    if (!bucket || !bucket.delete(peerKey)) return false;
    const index = this.mediaIndex.get(peerKey);
    index?.delete(callKey);
    if (index && !index.size) this.mediaIndex.delete(peerKey);
    if (!bucket.size) this.media.delete(callKey);
    return true;
  }

  _addMediaPeer(callKey, peer) {
    const peerKey = peerKeyOf(peer.address, peer.port);
    let bucket = this.media.get(callKey);
    if (!bucket) {
      bucket = new Map();
      this.media.set(callKey, bucket);
    }
    bucket.set(peerKey, peer);
    let index = this.mediaIndex.get(peerKey);
    if (!index) {
      index = new Set();
      this.mediaIndex.set(peerKey, index);
    }
    index.add(callKey);
  }

  _clearMediaForCall(callKey) {
    const bucket = this.media.get(callKey);
    if (bucket) {
      for (const peerKey of bucket.keys()) {
        const index = this.mediaIndex.get(peerKey);
        index?.delete(callKey);
        if (index && !index.size) this.mediaIndex.delete(peerKey);
      }
    }
    this.media.delete(callKey);
  }

  /**
   * Bind the UDP media socket. Resolves once the socket is listening with
   * { host, port, family }; with port:0 the OS assigns an ephemeral port.
   * Incoming datagrams are dispatched to relayRtp() for every call whose media
   * peer matches the sender's address:port.
   */
  startMediaRelay({ host = '127.0.0.1', port = 0, type = 'udp4' } = {}) {
    if (this.socket) this.stop();
    const socket = dgram.createSocket(type);
    socket.on('error', (err) => {
      this.lastError = err;
      this.stats.socketErrors += 1;
    });
    socket.on('message', (message, rinfo) => {
      const callKeys = this.mediaIndex.get(peerKeyOf(rinfo.address, rinfo.port));
      if (!callKeys || !callKeys.size) {
        this.stats.packetsDropped += 1;
        return;
      }
      for (const callKey of callKeys) this.relayRtp(callKey, rinfo, message);
    });

    this.socket = socket;
    this.stats.relaysStarted += 1;
    this.ready = new Promise((resolve, reject) => {
      const onListening = () => {
        socket.off('error', onBindError);
        const address = socket.address();
        this.mediaAddress = { host: address.address, port: address.port, family: address.family };
        resolve(this.mediaAddress);
      };
      const onBindError = (err) => {
        socket.off('listening', onListening);
        this.lastError = err;
        reject(err);
      };
      socket.once('listening', onListening);
      socket.once('error', onBindError);
      socket.bind(port, host);
    });
    return this.ready;
  }

  /**
   * Forward one opaque RTP datagram to the other media peers of the call.
   * The sender (identified by rinfo.address:rinfo.port) never receives its own
   * packet. No SRTP processing is performed: bytes are copied unchanged.
   * @returns {number} number of peers the datagram was sent to
   */
  relayRtp(callId, rinfo, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? Buffer.alloc(0));
    this.stats.packetsReceived += 1;
    if (!this.socket) {
      this.stats.packetsDropped += 1;
      return 0;
    }
    const bucket = this.media.get(keyOf(callId));
    if (!bucket || !bucket.size) {
      this.stats.packetsDropped += 1;
      return 0;
    }
    const senderKey = peerKeyOf(rinfo?.address ?? rinfo?.host, rinfo?.port ?? 0);
    let sent = 0;
    for (const [peerKey, peer] of bucket) {
      if (peerKey === senderKey) continue;
      try {
        this.socket.send(data, peer.port, peer.address);
        sent += 1;
      } catch {
        this.stats.packetsDropped += 1;
      }
    }
    this.stats.packetsForwarded += sent;
    return sent;
  }

  /** Stop the UDP relay; membership tables are kept. */
  stop() {
    if (!this.socket) return false;
    try {
      this.socket.close();
    } catch {
      // already closed
    }
    this.socket = null;
    this.mediaAddress = null;
    this.stats.relaysStopped += 1;
    return true;
  }

  /** Packet counters plus a snapshot of the current routing table sizes. */
  getStats() {
    let mediaPeers = 0;
    for (const bucket of this.media.values()) mediaPeers += bucket.size;
    return {
      ...this.stats,
      running: Boolean(this.socket),
      address: this.mediaAddress ? { ...this.mediaAddress } : null,
      calls: this.calls.size,
      mediaPeers,
    };
  }

  /** Stop the relay and drop all routing state. */
  close() {
    this.stop();
    this.calls.clear();
    this.media.clear();
    this.mediaIndex.clear();
    this.ready = null;
  }
}

export { peerKeyOf };
export default CallRelay;
