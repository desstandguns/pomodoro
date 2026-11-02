// テスト用の小道具
import { b64urlDecode, b64urlEncode, concatBytes, utf8 } from '../src/base64.js';

const subtle = globalThis.crypto.subtle;

export async function makeVapidEnv(extra = {}) {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    VAPID_PUBLIC_KEY: b64urlEncode(await subtle.exportKey('raw', pair.publicKey)),
    VAPID_PRIVATE_KEY: (await subtle.exportKey('jwk', pair.privateKey)).d,
    VAPID_SUBJECT: 'https://example.github.io/pomodoro/',
    ALLOWED_ORIGIN: 'https://example.github.io',
    ...extra
  };
}

// 受け取る側（ブラウザ役）の鍵
export async function makeReceiver() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    p256dh: b64urlEncode(await subtle.exportKey('raw', pair.publicKey)),
    auth: b64urlEncode(auth)
  };
}

async function hkdf(salt, ikm, info, n) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, n * 8));
}

// RFC 8291 の手順で、受け取る側として復号する
export async function decryptAes128gcm(body, uaPrivateKey, uaPublicB64, authB64) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const uaPublic = b64urlDecode(uaPublicB64);
  const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPrivateKey, 256));
  const ikm = await hkdf(b64urlDecode(authB64), ecdh, concatBytes(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--; // 詰め物の 0 を外す
  if (plain[end] !== 2) throw new Error('最後の印 0x02 がありません');
  return { rs, idlen, text: new TextDecoder().decode(plain.slice(0, end)) };
}

// Durable Object の保存場所のまね
export function fakeStorage() {
  const map = new Map();
  return {
    map,
    alarm: null,
    async get(k) { return map.get(k); },
    async put(k, v) { map.set(k, structuredClone(v)); },
    async deleteAll() { map.clear(); },
    async setAlarm(t) { this.alarm = t; },
    async deleteAlarm() { this.alarm = null; }
  };
}
