// Web Crypto API 加密层（Workers 兼容）
// AES-256-GCM 加密 + PBKDF2 密码哈希（替代 Node scrypt）

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

// 缓存已导入的 AES 密钥（同一 isolate 内复用，避免重复 importKey 调用）
const aesKeyCache = new Map();

async function importAesKey(keyHex) {
  let key = aesKeyCache.get(keyHex);
  if (key) return key;
  key = await crypto.subtle.importKey('raw', hexToBytes(keyHex), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  aesKeyCache.set(keyHex, key);
  return key;
}

// AES-256-GCM 加密，格式: ivHex:authTagHex:encHex（与 Node 版兼容）
export async function encrypt(plaintext, keyHex) {
  if (!plaintext) return null;
  const key = await importAesKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(String(plaintext));
  const result = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  // Web Crypto 把 auth tag(16字节) 附加在密文末尾
  const enc = result.slice(0, result.length - 16);
  const tag = result.slice(result.length - 16);
  return `${bytesToHex(iv)}:${bytesToHex(tag)}:${bytesToHex(enc)}`;
}

export async function decrypt(ciphertext, keyHex) {
  if (!ciphertext) return null;
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) return null;
    const iv = hexToBytes(parts[0]);
    const tag = hexToBytes(parts[1]);
    const enc = hexToBytes(parts[2]);
    // 拼接 enc + tag 供 Web Crypto 解密
    const combined = new Uint8Array(enc.length + tag.length);
    combined.set(enc, 0);
    combined.set(tag, enc.length);
    const key = await importAesKey(keyHex);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, combined);
    return decoder.decode(decrypted);
  } catch (_) {
    return null;
  }
}

// PBKDF2 密码哈希（Workers 不支持 scrypt），格式: saltHex:hashHex
const PBKDF2_ITERATIONS = 100000;

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return `${bytesToHex(salt)}:${bytesToHex(new Uint8Array(hash))}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  try {
    const parts = stored.split(':');
    if (parts.length !== 2) return false;
    const salt = hexToBytes(parts[0]);
    const expected = parts[1];
    const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
    const hash = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial, 256
    );
    return bytesToHex(new Uint8Array(hash)) === expected;
  } catch (_) {
    return false;
  }
}

export function randomUUID() {
  return crypto.randomUUID();
}
