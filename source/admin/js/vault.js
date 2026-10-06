/**
 * 口令保险箱
 * ---------------------------------------------------------------------------
 * 用管理口令把 GitHub Token 加密后保存在本机，不再明文入库。
 *
 *   · PBKDF2-HMAC-SHA256 派生密钥（随机 salt，迭代次数随密文一起存，便于日后调高）
 *   · AES-GCM 256 加密，随机 IV，自带完整性校验
 *   · 口令错误时 AES-GCM 解密会抛错，因此「解不开」即可判定口令不对
 *
 * 注意：WebCrypto 的 subtle 只在安全上下文可用。
 * https 与 http://localhost（含 127.0.0.1）都算安全上下文，本项目两种情况都满足；
 * 若确实不可用，调用方应降级为「只输 Token」并明确告知用户未加密。
 */

import { LS, safeGet, safeRemove, safeSet } from './config.js';

const ITERATIONS = 210000;   // OWASP 对 PBKDF2-SHA256 的建议量级，兼顾手机解锁速度
const SALT_BYTES = 16;
const IV_BYTES = 12;
const VERSION = 1;

/** WebCrypto 是否可用 */
export function isSupported() {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.getRandomValues === 'function';
}

/* ---------- base64 与字节互转 ---------- */

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- 密钥派生与加解密 ---------- */

async function deriveKey(password, salt, iterations) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iterations || ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * 用口令加密 Token
 * @returns {Promise<object>} 可 JSON 序列化的保险箱对象
 */
export async function encryptToken(token, password) {
  if (!isSupported()) throw new Error('当前环境不支持 WebCrypto，无法加密');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(token)
  );
  return {
    v: VERSION,
    kdf: 'PBKDF2-SHA256',
    iter: ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(new Uint8Array(ct)),
    at: Date.now(),
  };
}

/** 口令错误会抛出 code 为 WRONG_PASSWORD 的错误 */
export async function decryptToken(vault, password) {
  if (!vault || !vault.ct || !vault.salt || !vault.iv) throw new Error('保险箱数据不完整');
  const key = await deriveKey(password, fromB64(vault.salt), vault.iter);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(vault.iv) },
      key,
      fromB64(vault.ct)
    );
    return new TextDecoder().decode(pt);
  } catch (e) {
    const err = new Error('口令不正确');
    err.code = 'WRONG_PASSWORD';
    throw err;
  }
}

/* ---------- 持久化 ---------- */

export function readVault() {
  try {
    const raw = safeGet(LS.vault);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.ct || !o.salt || !o.iv) return null;
    return o;
  } catch (e) {
    return null;
  }
}

export function hasVault() {
  return !!readVault();
}

export function saveVault(vault) {
  safeSet(LS.vault, JSON.stringify(vault));
}

export function clearVault() {
  safeRemove(LS.vault);
}

/** 保险箱创建时间，用于界面上提示 */
export function vaultCreatedAt() {
  const v = readVault();
  return v && v.at ? new Date(v.at) : null;
}
