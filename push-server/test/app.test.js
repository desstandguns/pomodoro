import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, allowedOrigins } from '../src/app.js';
import { validateSchedule, BadRequest } from '../src/validate.js';
import { makeVapidEnv, makeReceiver } from './helpers.js';

const ORIGIN = 'https://example.github.io';
const NOW = 1_800_000_000_000;

// Durable Object 呼び出しのまね（呼ばれた内容を記録）
function fakeNamespace() {
  const calls = [];
  return {
    calls,
    idFromName: (name) => ({ name }),
    get: (id) => ({
      schedule: async (job) => { calls.push(['schedule', id.name, job]); },
      cancel: async () => { calls.push(['cancel', id.name]); }
    })
  };
}

async function setup() {
  const env = await makeVapidEnv({ ALLOWED_ORIGIN: ORIGIN + '/' });
  env.PUSH_TIMER = fakeNamespace();
  const r = await makeReceiver();
  const sub = { endpoint: 'https://web.push.apple.com/abc', expirationTime: null, keys: { p256dh: r.p256dh, auth: r.auth } };
  return { env, sub };
}

function req(method, path, { origin = ORIGIN, body } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request('https://pomodoro-push.example.workers.dev' + path, {
    method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
}

const good = (sub, extra = {}) => ({ subscription: sub, at: NOW + 25 * 60 * 1000, title: '作業おわり', body: '休憩しましょう', url: ORIGIN + '/pomodoro/', ...extra });

test('ALLOWED_ORIGIN はカンマ区切り・末尾の / を許す', () => {
  assert.deepEqual(allowedOrigins({ ALLOWED_ORIGIN: 'https://a.github.io/, http://localhost:8000' }), ['https://a.github.io', 'http://localhost:8000']);
});

test('GET /vapid-public-key は公開鍵を text/plain で返す', async () => {
  const { env } = await setup();
  const res = await handleRequest(req('GET', '/vapid-public-key'), env, NOW);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /^text\/plain/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(await res.text(), env.VAPID_PUBLIC_KEY);
});

test('CORS：プリフライトに答える', async () => {
  const { env } = await setup();
  const res = await handleRequest(req('OPTIONS', '/schedule'), env, NOW);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(res.headers.get('Access-Control-Allow-Methods'), /POST/);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /Content-Type/);
});

test('CORS：ほかのサイトからは 403', async () => {
  const { env, sub } = await setup();
  for (const r of [
    req('OPTIONS', '/schedule', { origin: 'https://evil.example' }),
    req('POST', '/schedule', { origin: 'https://evil.example', body: good(sub) }),
    req('POST', '/cancel', { origin: null, body: { endpoint: sub.endpoint } }),
    req('GET', '/vapid-public-key', { origin: 'https://evil.example' })
  ]) {
    const res = await handleRequest(r, env, NOW);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal(env.PUSH_TIMER.calls.length, 0);
});

test('POST /schedule：正しければ endpoint ごとのタイマー係に予約する', async () => {
  const { env, sub } = await setup();
  const res = await handleRequest(req('POST', '/schedule', { body: good(sub) }), env, NOW);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const [kind, name, job] = env.PUSH_TIMER.calls[0];
  assert.equal(kind, 'schedule');
  assert.equal(name, sub.endpoint);
  assert.equal(job.at, NOW + 25 * 60 * 1000);
  assert.deepEqual(job.subscription, { endpoint: sub.endpoint, keys: sub.keys });
});

test('POST /schedule：おかしな入力は 400', async () => {
  const { env, sub } = await setup();
  const bad = [
    '{not json',
    good(sub, { at: NOW + 3 * 3600 * 1000 + 1 }),
    good(sub, { at: NOW - 61 * 1000 }),
    good(sub, { at: '123' }),
    good(sub, { title: 'あ'.repeat(101) }),
    good(sub, { title: '' }),
    good(sub, { body: 'x'.repeat(201) }),
    good(sub, { url: 'https://evil.example/' }),
    good(sub, { url: './' }),
    good({ ...sub, endpoint: 'https://evil.example/push' }),
    good({ ...sub, endpoint: 'http://web.push.apple.com/abc' }),
    good({ ...sub, keys: { p256dh: sub.keys.p256dh, auth: 'short' } }),
    good({ ...sub, keys: { p256dh: 'AAAA', auth: sub.keys.auth } }),
    { at: NOW }
  ];
  for (const body of bad) {
    const res = await handleRequest(req('POST', '/schedule', { body }), env, NOW);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    const data = await res.json();
    assert.equal(data.ok, false);
  }
  assert.equal(env.PUSH_TIMER.calls.length, 0);
});

test('POST /schedule：境界の値は通る', async () => {
  const { sub } = await setup();
  const opts = { now: NOW, allowedOrigins: [ORIGIN] };
  assert.ok(validateSchedule(good(sub, { at: NOW + 3 * 3600 * 1000 }), opts));
  assert.ok(validateSchedule(good(sub, { at: NOW - 60 * 1000 }), opts));
  assert.ok(validateSchedule(good(sub, { title: 'あ'.repeat(100), body: '' }), opts));
  assert.throws(() => validateSchedule(null, opts), BadRequest);
});

test('POST /cancel：endpoint のタイマー係を止める', async () => {
  const { env, sub } = await setup();
  const res = await handleRequest(req('POST', '/cancel', { body: { endpoint: sub.endpoint } }), env, NOW);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(env.PUSH_TIMER.calls[0], ['cancel', sub.endpoint]);
  const bad = await handleRequest(req('POST', '/cancel', { body: { endpoint: 123 } }), env, NOW);
  assert.equal(bad.status, 400);
});

test('知らない場所は 404', async () => {
  const { env } = await setup();
  const res = await handleRequest(req('POST', '/nothing', { body: {} }), env, NOW);
  assert.equal(res.status, 404);
});
