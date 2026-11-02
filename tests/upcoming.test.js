// これから追加される機能のテスト。
// まだ画面に部品（#cycle など）がないときは「スキップ（とばす）」になるので、
// 機能が入る前でも後でも、テスト全体は緑のままです。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, openApp, text, MIN, recordNotesScript, waitFor, advance } = require('./helpers');

const env = setup(test);
const T0 = new Date('2026-11-02T10:00:00+09:00');

// 部品がなければスキップする。あれば true を返す
async function has(t, page, selector) {
  if (await page.$(selector)) return true;
  t.skip(`${selector} はまだありません（未実装）`);
  return false;
}

const mmss = (min) => `${String(min).padStart(2, '0')}:00`;

// ===== 長い休憩 =====

test('長い休憩: 25分なら 休憩は 5,5,5,15分。#cycle は 1/4〜4/4', async (t) => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    if (!(await has(t, page, '#cycle'))) return;
    assert.equal(await text(page, '#cycle'), '1/4');
    await page.click('#startBtn');

    const breaks = [5, 5, 5, 15];
    for (let i = 1; i <= 4; i++) {
      assert.equal(await text(page, '#mode'), '作業');
      assert.equal(await text(page, '#cycle'), `${i}/4`);
      if (i === 4) assert.equal(await text(page, '#status'), '終わったら15分の長い休憩です');

      await advance(page, 25 * MIN);
      assert.equal(await page.getAttribute('html', 'data-phase'), 'break');
      assert.equal(await text(page, '#mode'), i === 4 ? '長い休憩' : '休憩');
      assert.equal(await text(page, '#time'), mmss(breaks[i - 1]), `${i}回目の休憩の長さ`);
      assert.equal(await text(page, '#cycle'), `${i}/4`); // 休憩中は「終わった回」を表示

      await advance(page, breaks[i - 1] * MIN);
      assert.equal(await page.getAttribute('html', 'data-phase'), 'work');
      assert.equal(await text(page, '#time'), '25:00');
    }
    assert.equal(await text(page, '#count'), '4回');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

for (const [work, rest, long] of [[45, 10, 20], [60, 15, 30]]) {
  test(`長い休憩: ${work}分なら4回目のあとは${long}分`, async (t) => {
    const { context, page, errors } = await openApp(env, { time: T0 });
    try {
      if (!(await has(t, page, '#cycle'))) return;
      await page.click(`#lengths button[data-min="${work}"]`);
      await page.click('#startBtn');
      for (let i = 1; i <= 3; i++) {
        await advance(page, work * MIN);
        assert.equal(await text(page, '#time'), mmss(rest));
        await advance(page, rest * MIN);
      }
      await advance(page, work * MIN);
      assert.equal(await text(page, '#mode'), '長い休憩');
      assert.equal(await text(page, '#time'), mmss(long));
      assert.equal(await text(page, '#cycle'), '4/4');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test('長い休憩: リセットや作業時間の変更で 1/4 に戻る', async (t) => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    if (!(await has(t, page, '#cycle'))) return;
    await page.click('#startBtn');
    await advance(page, 30 * MIN); // 1回目の作業＋休憩が終わる
    assert.equal(await text(page, '#cycle'), '2/4');
    await page.click('#resetBtn');
    assert.equal(await text(page, '#cycle'), '1/4');

    await page.click('#startBtn');
    await advance(page, 30 * MIN);
    assert.equal(await text(page, '#cycle'), '2/4');
    await page.click('#startBtn'); // 一時停止（動いている間は長さを変えられない）
    await page.click('#lengths button[data-min="45"]');
    assert.equal(await text(page, '#cycle'), '1/4');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// ===== 音を試すボタン =====

test('「音を試す」: 3つの音が鳴り、タイマーは変わらない', async (t) => {
  const { context, page, errors } = await openApp(env, { initScripts: [recordNotesScript] });
  try {
    if (!(await has(t, page, '#testSoundBtn'))) return;
    assert.equal(await text(page, '#testSoundBtn'), '音を試す');
    const before = [await text(page, '#time'), await text(page, '#mode'), await text(page, '#startBtn')];

    await page.evaluate(() => { window.__notes = []; });
    await page.click('#testSoundBtn');
    const notes = await waitFor(page, () => window.__notes.length >= 3 && window.__notes.slice());
    assert.equal(notes.length, 3, `3音のはず: ${notes}`);

    const after = [await text(page, '#time'), await text(page, '#mode'), await text(page, '#startBtn')];
    assert.deepEqual(after, before);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// ===== 通知（ホーム画面アプリのプッシュ通知） =====

// 本物の PomodoroPush を「ないこと」にする（あとから代入されても無視する）
const noPushScript = () => {
  Object.defineProperty(window, 'PomodoroPush', { configurable: true, get: () => undefined, set: () => {} });
};

// 偽物の PomodoroPush。呼ばれた内容を window.__push.calls に記録する
const stubPushScript = () => {
  const state = { enabled: false, calls: [] };
  window.__push = state;
  const stub = {
    isSupported: () => true,
    needsHomeScreen: () => false,
    permission: () => 'granted',
    isEnabled: () => state.enabled,
    enable: async () => { state.calls.push({ fn: 'enable' }); state.enabled = true; return true; },
    disable: async () => { state.calls.push({ fn: 'disable' }); state.enabled = false; return true; },
    schedule: async (opts) => { state.calls.push({ fn: 'schedule', opts: { ...opts, at: +new Date(opts.at) } }); return true; },
    cancel: async () => { state.calls.push({ fn: 'cancel' }); return true; },
  };
  Object.defineProperty(window, 'PomodoroPush', { configurable: true, get: () => stub, set: () => {} });
};

const calls = (page, fn) => page.evaluate((f) => window.__push.calls.filter((c) => c.fn === f), fn);
const waitCalls = (page, fn, n) =>
  waitFor(page, ([f, k]) => window.__push.calls.filter((c) => c.fn === f).length >= k, [fn, n]);

test('通知ボタン: PomodoroPush がないときは表示しない', async (t) => {
  const { context, page, errors } = await openApp(env, { initScripts: [noPushScript] });
  try {
    if (!(await has(t, page, '#notifyBtn'))) return;
    assert.equal(await page.locator('#notifyBtn').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('通知: スタートで予約、一時停止・リセットで取り消し、切り替わりで次を予約', async (t) => {
  const { context, page, errors } = await openApp(env, { time: T0, initScripts: [stubPushScript] });
  try {
    if (!(await has(t, page, '#notifyBtn'))) return;
    assert.equal(await page.locator('#notifyBtn').isVisible(), true);

    // 通知をオンにする
    await page.click('#notifyBtn');
    await waitFor(page, () => window.__push.enabled);

    // スタート → 25分後に「作業おわり」を予約
    const startAt = await page.evaluate(() => Date.now());
    await page.click('#startBtn');
    await waitCalls(page, 'schedule', 1);
    let s = (await calls(page, 'schedule')).at(-1).opts;
    assert.equal(s.title, '作業おわり');
    assert.equal(s.body, '5分休憩しましょう');
    assert.ok(Math.abs(s.at - (startAt + 25 * MIN)) < 2000, `終わる時刻のはず: ${s.at - startAt}ms 後`);

    // 一時停止 → 取り消し
    await page.click('#startBtn');
    await waitCalls(page, 'cancel', 1);
    const cancelsAfterPause = (await calls(page, 'cancel')).length;

    // 再開してリセット → 取り消し
    await page.click('#startBtn');
    await waitCalls(page, 'schedule', 2);
    await page.click('#resetBtn');
    await waitCalls(page, 'cancel', cancelsAfterPause + 1);

    // 動いたまま作業→休憩に切り替わる → 「休憩おわり」を予約
    const n = (await calls(page, 'schedule')).length;
    await page.click('#startBtn');
    await waitCalls(page, 'schedule', n + 1);
    const switchAt = await page.evaluate(() => Date.now() + 25 * 60 * 1000);
    await advance(page, 25 * MIN);
    await waitFor(page, () => window.__push.calls.filter((c) => c.fn === 'schedule').at(-1).opts.title === '休憩おわり');
    s = (await calls(page, 'schedule')).at(-1).opts;
    assert.equal(s.body, '次の作業を始めましょう');
    assert.ok(Math.abs(s.at - (switchAt + 5 * MIN)) < 2000, '休憩の終わる時刻のはず');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// ===== 記録（履歴） =====

test('記録: 作業を終えると pomodoro-history に日付ごとの回数が残る', async (t) => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    if (!(await has(t, page, '#historyPanel'))) return;
    assert.equal(await page.$eval('#historyPanel', (el) => el.tagName), 'DETAILS');
    assert.equal((await text(page, '#historyPanel > summary')).trim(), '記録');

    await page.click('#startBtn');
    await advance(page, 25 * MIN);
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('pomodoro-history')));
    assert.equal(history['2026-11-02'], 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// ===== レイアウト =====

test('レイアウト: 390×844 の画面でページがスクロールしない（記録は閉じた状態）', async () => {
  const { context, page, errors } = await openApp(env);
  try {
    await page.evaluate(() => {
      const panel = document.getElementById('historyPanel');
      if (panel) panel.open = false;
    });
    const { scroll, inner } = await page.evaluate(() => ({
      scroll: document.scrollingElement.scrollHeight,
      inner: window.innerHeight,
    }));
    assert.ok(scroll <= inner, `ページの高さ ${scroll}px が画面の高さ ${inner}px をこえている`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
