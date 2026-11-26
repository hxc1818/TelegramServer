// Runtime configuration + RSA key material.
// Zero npm dependencies; keys are loaded with the helpers from src/crypto/rsa.js.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateRSA, rsaFingerprint } from './crypto/rsa.js';

const DEFAULTS = {
  listenHost: '0.0.0.0',
  listenPort: 10443,
  dataDir: './data',
  publicIp: '127.0.0.1',
  serverId: 1,
  apiId: 17349,
  apiHash: '344583e45741c457fe1862106095a5eb',
  authCode: '22222',
  layer: 234,
  dbDriver: 'sqlite',
  adminHost: '127.0.0.1',
  adminPort: 18080,
  adminToken: '',
};

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function keyFromPem(pem) {
  const privateKey = crypto.createPrivateKey(pem);
  const jwk = privateKey.export({ format: 'jwk' });
  const n = Buffer.from(jwk.n, 'base64url');
  const e = Buffer.from(jwk.e, 'base64url');
  const d = Buffer.from(jwk.d, 'base64url');
  return {
    n,
    e,
    d,
    privatePem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    // TDesktop 的 kPublicRSAKeys 使用 PKCS#1 "BEGIN RSA PUBLIC KEY" 文本，
    // 补丁脚本也校验这个头，因此这里必须导出 pkcs1 而不是 spki。
    publicPem: crypto.createPublicKey(privateKey).export({ type: 'pkcs1', format: 'pem' }).toString(),
    fingerprint: rsaFingerprint(n, e),
  };
}

/**
 * Return the server key material.
 * RSA_PRIVATE_KEY may be a path to a PKCS#1/PKCS#8 PEM or the PEM itself.
 * When nothing usable is supplied, DATA_DIR/rsa.pem is created (2048-bit).
 */
export function loadKeys(config = {}) {
  const dataDir = config.dataDir || DEFAULTS.dataDir;
  const configured = config.rsaPrivateKey ?? process.env.RSA_PRIVATE_KEY;
  const defaultPath = path.join(dataDir, 'rsa.pem');

  let pem = null;
  if (configured) {
    if (String(configured).includes('-----BEGIN')) {
      pem = String(configured);
    } else if (fs.existsSync(configured)) {
      pem = fs.readFileSync(configured, 'utf8');
    }
  }
  if (!pem && fs.existsSync(defaultPath)) {
    pem = fs.readFileSync(defaultPath, 'utf8');
  }
  if (!pem) {
    fs.mkdirSync(dataDir, { recursive: true });
    const generated = generateRSA(); // crypto.generateKeyPairSync, 2048 bits
    pem = generated.privatePem;
    fs.writeFileSync(defaultPath, pem, { mode: 0o600 });
  }
  return keyFromPem(pem);
}

/** Load all configuration from the environment (synchronous, dependency-free). */
export function loadConfig() {
  const dataDir = process.env.DATA_DIR || DEFAULTS.dataDir;
  fs.mkdirSync(dataDir, { recursive: true });

  const config = {
    listenHost: process.env.LISTEN_HOST || DEFAULTS.listenHost,
    listenPort: envInt('LISTEN_PORT', DEFAULTS.listenPort),
    dataDir,
    publicIp: process.env.PUBLIC_IP || process.env.LISTEN_HOST || DEFAULTS.publicIp,
    serverId: envInt('SERVER_ID', DEFAULTS.serverId),
    rsaPrivateKey: process.env.RSA_PRIVATE_KEY || '',
    apiId: envInt('API_ID', DEFAULTS.apiId),
    apiHash: process.env.API_HASH || DEFAULTS.apiHash,
    authCode: process.env.AUTH_CODE || DEFAULTS.authCode,
    layer: envInt('API_LAYER', DEFAULTS.layer),
    dbDriver: (process.env.DB_DRIVER || DEFAULTS.dbDriver).toLowerCase(),
    adminHost: process.env.ADMIN_HOST || DEFAULTS.adminHost,
    adminPort: envInt('ADMIN_PORT', DEFAULTS.adminPort),
    adminToken: process.env.ADMIN_TOKEN || DEFAULTS.adminToken,
    logTL: envBool('LOG_TL', false),
  };
  config.keys = loadKeys(config);
  return config;
}

export default loadConfig;
