import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64urlDecode, b64urlEncode, utf8 } from '../src/base64.js';
import { importVapidKeys, createVapidJwt, encryptPayload, buildPayload, sendPush } from '../src/webpush.js';
import { makeVapidEnv, makeReceiver, decryptAes128gcm } from './helpers.js';

test('base64url の往復', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(65));
  const s = b64urlEncode(bytes);
  assert.match(s, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(b64urlDecode(s), bytes);
});

test('VAPID JWT：署名して公開鍵で確かめられる', async () => {
  const env = await makeVapidEnv();
  const { privateKey, publicKeyB64 } = await importVapidKeys(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const now = 1_700_000_000;
  const jwt = await createVapidJwt({ audience: 'https://web.push.apple.com', subject: env.VAPID_SUBJECT, privateKey, nowSec: now });
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(h))), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, env.VAPID_SUBJECT);
  assert.equal(claims.exp, now + 12 * 3600);
  const sig = b64urlDecode(s);
  assert.equal(sig.length, 64);
  const pub = await crypto.subtle.importKey('raw', b64urlDecode(publicKeyB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, utf8(`${h}.${c}`)));
  // 中身を変えると確かめに失敗する
  assert.ok(!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, utf8(`${h}.${c}x`))));
});

test('aes128gcm：RFC 8291 付録A の例と一致する', async () => {
  const out = await encryptPayload(
    'When I grow up, I want to be a watermelon',
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    'BTBZMqHH6r4Tts7J_aSIgg',
    {
      privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
      publicKey: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
      salt: 'DGv6ra1nlYgDCS1FRnbzlw'
    }
  );
  assert.equal(
    b64urlEncode(out),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
  );
});

test('aes128gcm：受け取る側の鍵で復号して元に戻る', async () => {
  const r = await makeReceiver();
  const payload = buildPayload({ title: '休憩しましょう', body: '25分おつかれさま', url: 'https://example.github.io/pomodoro/' });
  const body = await encryptPayload(payload, r.p256dh, r.auth);
  const { rs, idlen, text } = await decryptAes128gcm(body, r.privateKey, r.p256dh, r.auth);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  assert.equal(text, payload);
  assert.deepEqual(JSON.parse(text), {
    web_push: 8030,
    notification: { title: '休憩しましょう', body: '25分おつかれさま', navigate: 'https://example.github.io/pomodoro/', tag: 'pomodoro', silent: false }
  });
});

test('sendPush：ヘッダーと中身が正しい', async () => {
  const env = await makeVapidEnv();
  const r = await makeReceiver();
  const endpoint = 'https://web.push.apple.com/QGuQyavXutnMbBn3';
  let captured;
  const res = await sendPush({
    subscription: { endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
    payload: 'hello',
    env,
    fetchImpl: async (url, init) => { captured = { url, init }; return new Response(null, { status: 201 }); }
  });
  assert.equal(res.status, 201);
  assert.equal(captured.url, endpoint);
  const h = captured.init.headers;
  assert.equal(h.TTL, '600');
  assert.equal(h.Urgency, 'high');
  assert.equal(h['Content-Encoding'], 'aes128gcm');
  assert.match(h.Authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${env.VAPID_PUBLIC_KEY}$`));
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(h.Authorization.split('.')[1])));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  const { text } = await decryptAes128gcm(captured.init.body, r.privateKey, r.p256dh, r.auth);
  assert.equal(text, 'hello');
});
