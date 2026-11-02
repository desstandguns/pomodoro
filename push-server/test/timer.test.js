import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleJob, clearJob, runAlarm } from '../src/timer.js';
import { makeVapidEnv, makeReceiver, fakeStorage, decryptAes128gcm } from './helpers.js';

const AT = 1_800_000_000_000;

async function setup() {
  const env = await makeVapidEnv();
  const r = await makeReceiver();
  const storage = fakeStorage();
  const job = {
    subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', keys: { p256dh: r.p256dh, auth: r.auth } },
    at: AT, title: 'おわり', body: '休憩', url: 'https://example.github.io/pomodoro/'
  };
  await scheduleJob(storage, job);
  return { env, r, storage, job };
}

const respond = (status) => async () => new Response('', { status });

test('予約するとアラームが設定され、上書きできる', async () => {
  const { storage, job } = await setup();
  assert.equal(storage.alarm, AT);
  await scheduleJob(storage, { ...job, at: AT + 1000 });
  assert.equal(storage.alarm, AT + 1000);
  assert.equal((await storage.get('job')).at, AT + 1000);
  await clearJob(storage);
  await clearJob(storage); // 2回目も大丈夫
  assert.equal(storage.alarm, null);
  assert.equal(await storage.get('job'), undefined);
});

test('時間になると通知を送り、予約を消す', async () => {
  const { env, r, storage } = await setup();
  let sent;
  const result = await runAlarm(storage, env, {
    now: AT, fetchImpl: async (url, init) => { sent = init; return new Response(null, { status: 201 }); }
  });
  assert.equal(result, 'sent');
  assert.equal(await storage.get('job'), undefined);
  const { text } = await decryptAes128gcm(sent.body, r.privateKey, r.p256dh, r.auth);
  assert.equal(JSON.parse(text).notification.title, 'おわり');
});

for (const status of [404, 410]) {
  test(`${status} が返ったら購読を消す`, async () => {
    const { env, storage } = await setup();
    assert.equal(await runAlarm(storage, env, { now: AT, fetchImpl: respond(status) }), 'gone');
    assert.equal(storage.map.size, 0);
    assert.equal(storage.alarm, null);
  });
}

test('一時的な失敗は少し待って2回までやり直す', async () => {
  const { env, storage } = await setup();
  assert.equal(await runAlarm(storage, env, { now: AT, fetchImpl: respond(503) }), 'retry');
  assert.equal(storage.alarm, AT + 5000);
  assert.equal(await runAlarm(storage, env, { now: AT + 5000, fetchImpl: async () => { throw new Error('net'); } }), 'retry');
  assert.equal(await runAlarm(storage, env, { now: AT + 15000, fetchImpl: respond(500) }), 'failed');
  assert.equal(storage.map.size, 0);
});

test('400 などは やり直さずに消す／遅すぎたら送らない', async () => {
  let s = await setup();
  assert.equal(await runAlarm(s.storage, s.env, { now: AT, fetchImpl: respond(400) }), 'failed');
  s = await setup();
  let called = false;
  assert.equal(await runAlarm(s.storage, s.env, { now: AT + 11 * 60 * 1000, fetchImpl: async () => { called = true; } }), 'expired');
  assert.equal(called, false);
  assert.equal(await runAlarm(s.storage, s.env, { now: AT }), 'none');
});
