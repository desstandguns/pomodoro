// VAPID の鍵ペアを作って表示する。使い方：node scripts/generate-vapid-keys.mjs
// 表示された2つの値を npx wrangler secret put で登録してください（人に見せないこと）
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = b64url(await subtle.exportKey('raw', pair.publicKey)); // 65バイト
const privateKey = (await subtle.exportKey('jwk', pair.privateKey)).d;   // 32バイト

console.log('VAPID_PUBLIC_KEY=' + publicKey);
console.log('VAPID_PRIVATE_KEY=' + privateKey);
