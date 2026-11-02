// 届いたデータが正しいかを調べる
import { b64urlDecode } from './base64.js';

export const MAX_AHEAD_MS = 3 * 60 * 60 * 1000; // 3時間より先は受け付けない
export const MAX_PAST_MS = 60 * 1000;           // 60秒より前も受け付けない
export const MAX_TITLE = 100;
export const MAX_BODY = 200;
export const MAX_URL = 500;
const MAX_ENDPOINT = 2048;

// 通知を届ける会社（Apple・Google・Mozilla・Microsoft）の住所だけを許す
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];

export class BadRequest extends Error {}

function fail(msg) { throw new BadRequest(msg); }

export function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT) fail('endpoint が正しくありません');
  let u;
  try { u = new URL(endpoint); } catch { fail('endpoint が URL ではありません'); }
  if (u.protocol !== 'https:') fail('endpoint は https である必要があります');
  const host = u.hostname.toLowerCase();
  if (!PUSH_HOSTS.some((h) => host === h || host.endsWith('.' + h))) fail('対応していない通知サービスです');
  return endpoint;
}

function keyBytes(value, len, name) {
  let bytes;
  try { bytes = b64urlDecode(value); } catch { fail(`${name} が正しくありません`); }
  if (bytes.length !== len) fail(`${name} の長さが正しくありません`);
  return bytes;
}

export function validateSubscription(sub) {
  if (!sub || typeof sub !== 'object') fail('subscription がありません');
  const endpoint = validateEndpoint(sub.endpoint);
  const keys = sub.keys;
  if (!keys || typeof keys !== 'object') fail('subscription.keys がありません');
  const p256dh = keyBytes(keys.p256dh, 65, 'p256dh');
  if (p256dh[0] !== 4) fail('p256dh の形が正しくありません');
  keyBytes(keys.auth, 16, 'auth');
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function text(value, max, name, allowEmpty) {
  if (typeof value !== 'string') fail(`${name} は文字列にしてください`);
  if (!allowEmpty && value.trim() === '') fail(`${name} が空です`);
  if ([...value].length > max) fail(`${name} は${max}文字までです`);
  return value;
}

// /schedule の中身を調べて、保存する形にして返す
export function validateSchedule(data, { now, allowedOrigins }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('JSON の形が正しくありません');
  const subscription = validateSubscription(data.subscription);
  const at = data.at;
  if (typeof at !== 'number' || !Number.isFinite(at)) fail('at は数値（ミリ秒）にしてください');
  if (at < now - MAX_PAST_MS) fail('at が過去すぎます');
  if (at > now + MAX_AHEAD_MS) fail('at が3時間より先です');
  const title = text(data.title, MAX_TITLE, 'title', false);
  const body = text(data.body, MAX_BODY, 'body', true);
  const url = text(data.url, MAX_URL, 'url', false);
  // 通知を押したときに開くページは、アプリと同じサイトだけにする
  let u;
  try { u = new URL(url); } catch { fail('url は https:// から始まる完全な URL にしてください'); }
  if (!allowedOrigins.includes(u.origin)) fail('url がアプリのサイトではありません');
  return { subscription, at: Math.round(at), title, body, url: u.href };
}

export function validateCancel(data) {
  if (!data || typeof data !== 'object') fail('JSON の形が正しくありません');
  return { endpoint: validateEndpoint(data.endpoint) };
}
