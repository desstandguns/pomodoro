// 受付窓口：URL ごとに仕事を振り分ける
import { validateSchedule, validateCancel, BadRequest } from './validate.js';

const MAX_BODY_BYTES = 8 * 1024;

// ALLOWED_ORIGIN はカンマ区切りで複数書ける（末尾の / は無視）
export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function json(status, data, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra }
  });
}

async function readJson(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new BadRequest('データが大きすぎます');
  try { return JSON.parse(text); } catch { throw new BadRequest('JSON が読めません'); }
}

// 購読の住所ごとに1つの「タイマー係」（Durable Object）を呼び出す
function timerFor(env, endpoint) {
  return env.PUSH_TIMER.get(env.PUSH_TIMER.idFromName(endpoint));
}

export async function handleRequest(request, env, now = Date.now()) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const origin = request.headers.get('Origin');
  const origins = allowedOrigins(env);
  const okOrigin = origin !== null && origins.includes(origin);
  const cors = okOrigin ? corsHeaders(origin) : { Vary: 'Origin' };

  // 動作確認用：ブラウザで直接開くと「動いています」と出る
  if (request.method === 'GET' && path === '/' && !origin) {
    return new Response('pomodoro push server: 動いています\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  // 公開鍵は秘密ではないので、ブラウザで直接開いて確かめてもよい（Origin なし）
  if (request.method === 'GET' && path === '/vapid-public-key' && (okOrigin || !origin)) {
    return new Response(env.VAPID_PUBLIC_KEY || '', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...cors }
    });
  }

  // 許可したサイト以外からは断る
  if (!okOrigin) return json(403, { ok: false, error: 'このサイトからは使えません' }, cors);

  // ブラウザの事前確認（プリフライト）
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  try {
    if (request.method === 'POST' && path === '/schedule') {
      const job = validateSchedule(await readJson(request), { now, allowedOrigins: origins });
      await timerFor(env, job.subscription.endpoint).schedule(job);
      return json(200, { ok: true }, cors);
    }
    if (request.method === 'POST' && path === '/cancel') {
      const { endpoint } = validateCancel(await readJson(request));
      await timerFor(env, endpoint).cancel();
      return json(200, { ok: true }, cors);
    }
    return json(404, { ok: false, error: 'ありません' }, cors);
  } catch (e) {
    if (e instanceof BadRequest) return json(400, { ok: false, error: e.message }, cors);
    console.log('サーバーエラー', String(e && e.stack || e));
    return json(500, { ok: false, error: 'サーバーでエラーが起きました' }, cors);
  }
}
