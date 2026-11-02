// Web Push の送信部品（VAPID の署名と、中身の暗号化）
// WebCrypto だけを使うので、Cloudflare Workers でも Node でも動く
import { b64urlEncode, b64urlDecode, concatBytes, utf8 } from './base64.js';

const subtle = globalThis.crypto.subtle;
const RECORD_SIZE = 4096;

// 65バイトの公開鍵（04 + x + y）を JWK の形にする
function pointToJwk(pub) {
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('公開鍵の形が正しくありません');
  return { kty: 'EC', crv: 'P-256', x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33)) };
}

// ---- VAPID（このサーバーが「本物の送り主」だと示す署名） ----

// 鍵を WebCrypto で使える形に読み込む
export async function importVapidKeys(publicKeyB64, privateKeyB64) {
  const pub = b64urlDecode(publicKeyB64);
  const d = b64urlDecode(privateKeyB64);
  if (d.length !== 32) throw new Error('VAPID 秘密鍵の長さが正しくありません');
  const jwk = { ...pointToJwk(pub), d: b64urlEncode(d), ext: false };
  const privateKey = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { publicKeyB64: b64urlEncode(pub), privateKey };
}

// ES256 の JWT を作る（有効期限は12時間）
export async function createVapidJwt({ audience, subject, privateKey, nowSec = Math.floor(Date.now() / 1000) }) {
  const header = b64urlEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(utf8(JSON.stringify({ aud: audience, exp: nowSec + 12 * 3600, sub: subject })));
  const input = `${header}.${claims}`;
  // WebCrypto の署名は r||s の64バイトで、JWT の形そのまま
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, utf8(input));
  return `${input}.${b64urlEncode(sig)}`;
}

// ---- 中身の暗号化（RFC 8291 / aes128gcm） ----

async function hkdf(salt, ikm, info, bytes) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8);
  return new Uint8Array(bits);
}

// testKeys はテスト用（決まった鍵と salt で RFC の例と同じ結果を出すため）
export async function encryptPayload(plaintext, uaPublicB64, authSecretB64, testKeys) {
  const uaPublic = b64urlDecode(uaPublicB64);
  const authSecret = b64urlDecode(authSecretB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh が正しくありません');
  if (authSecret.length !== 16) throw new Error('auth が正しくありません');

  // 使い捨ての鍵ペア（送るたびに新しく作る）
  let asPrivate, asPublic;
  if (testKeys) {
    asPublic = b64urlDecode(testKeys.publicKey);
    asPrivate = await subtle.importKey('jwk', { ...pointToJwk(asPublic), d: testKeys.privateKey },
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  }
  const salt = testKeys ? b64urlDecode(testKeys.salt) : crypto.getRandomValues(new Uint8Array(16));

  const uaKey = await subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));

  const keyInfo = concatBytes(utf8('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const data = typeof plaintext === 'string' ? utf8(plaintext) : plaintext;
  if (data.length > RECORD_SIZE - 17) throw new Error('中身が大きすぎます');
  // 最後のかたまりの印として 0x02 を付ける
  const padded = concatBytes(data, new Uint8Array([2]));
  const aesKey = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  // 先頭の情報：salt(16) + かたまりの大きさ(4) + 鍵の長さ(1) + 使い捨て公開鍵(65)
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concatBytes(header, asPublic, cipher);
}

// ---- 通知の中身 ----

// Declarative Web Push の形（Safari 18.4 以降はサービスワーカーなしでも表示できる）
export function buildPayload({ title, body, url }) {
  return JSON.stringify({
    web_push: 8030,
    notification: { title, body, navigate: url, tag: 'pomodoro', silent: false }
  });
}

// ---- 送信 ----

export async function sendPush({ subscription, payload, env, fetchImpl = fetch, ttl = 600 }) {
  const { publicKeyB64, privateKey } = await importVapidKeys(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await createVapidJwt({ audience, subject: env.VAPID_SUBJECT, privateKey });
  const body = await encryptPayload(payload, subscription.keys.p256dh, subscription.keys.auth);
  return fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${publicKeyB64}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'high'
    },
    body
  });
}
