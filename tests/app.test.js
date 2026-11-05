// いまのタイマーの動きを確かめるテスト
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, openApp, text, toSeconds, MIN, recordNotesScript, waitFor, advance, ROOT } = require('./helpers');

const env = setup(test);

// テストの「今」は 2026年11月2日 10:00（日本時間）から始める
const T0 = new Date('2026-11-02T10:00:00+09:00');

test('最初の画面: 25:00・作業・スタート', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    assert.equal(await text(page, '#time'), '25:00');
    assert.equal(await text(page, '#mode'), '作業');
    assert.equal(await text(page, '#startBtn'), 'スタート');
    assert.equal(await text(page, '#count'), '0回');
    assert.equal(await page.getAttribute('html', 'data-phase'), 'work');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('スタート → 一時停止 → 再開 → リセット', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await page.click('#startBtn');
    assert.equal(await text(page, '#startBtn'), '一時停止');
    assert.equal(await text(page, '#status'), '終わったら5分休憩です');

    await page.clock.runFor(3000);
    assert.equal(await text(page, '#time'), '24:57');

    await page.click('#startBtn'); // 一時停止
    assert.equal(await text(page, '#startBtn'), '再開');
    assert.equal(await text(page, '#status'), '一時停止中');

    // 止めている間は時間が減らない
    await page.clock.runFor(10_000);
    assert.equal(await text(page, '#time'), '24:57');

    await page.click('#startBtn'); // 再開
    assert.equal(await text(page, '#startBtn'), '一時停止');
    await page.clock.runFor(2000);
    assert.equal(await text(page, '#time'), '24:55');

    await page.click('#resetBtn');
    assert.equal(await text(page, '#time'), '25:00');
    assert.equal(await text(page, '#startBtn'), 'スタート');
    assert.equal(await text(page, '#mode'), '作業');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('作業時間の切り替え: 45分を選ぶと45:00、再読み込みしても覚えている', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    const pressed = () =>
      page.$$eval('#lengths button', (bs) => bs.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.min));

    assert.deepEqual(await pressed(), ['25']);
    await page.click('#lengths button[data-min="45"]');
    assert.equal(await text(page, '#time'), '45:00');
    assert.deepEqual(await pressed(), ['45']);
    assert.match(await text(page, '#status'), /45分の作業/);

    await page.reload();
    assert.equal(await text(page, '#time'), '45:00');
    assert.deepEqual(await pressed(), ['45']);

    // 動いている間は押せない
    await page.click('#startBtn');
    const disabled = await page.$$eval('#lengths button', (bs) => bs.map((b) => b.disabled));
    assert.deepEqual(disabled, [true, true, true, true, true]);

    await page.click('#startBtn'); // 一時停止すると押せる
    const enabled = await page.$$eval('#lengths button', (bs) => bs.map((b) => b.disabled));
    assert.deepEqual(enabled, [false, false, false, false, false]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// 作業→休憩→作業 の切り替わり（25分/45分/60分それぞれ）
for (const [work, rest] of [[25, 5], [45, 10], [60, 15]]) {
  test(`${work}分の作業のあとは${rest}分の休憩、そのあと作業に戻る`, async () => {
    const { context, page, errors } = await openApp(env, { time: T0 });
    try {
      if (work !== 25) await page.click(`#lengths button[data-min="${work}"]`);
      await page.click('#startBtn');

      await advance(page, work * MIN);
      assert.equal(await text(page, '#mode'), '休憩');
      assert.equal(await page.getAttribute('html', 'data-phase'), 'break');
      assert.equal(await text(page, '#time'), `${String(rest).padStart(2, '0')}:00`);
      assert.equal(await text(page, '#count'), '1回');
      assert.equal(await page.locator('#dots span').count(), 1);
      assert.equal(await text(page, '#startBtn'), '一時停止'); // 休憩は自動で始まる

      await advance(page, rest * MIN);
      assert.equal(await text(page, '#mode'), '作業');
      assert.equal(await page.getAttribute('html', 'data-phase'), 'work');
      assert.equal(await text(page, '#time'), `${work}:00`);
      assert.equal(await text(page, '#count'), '1回');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test('ほかのアプリに切り替えて2時間たってから戻っても、正しく進んでいる', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await page.click('#startBtn');

    // 画面が見えていない状態にする
    await page.evaluate(() => {
      window.__hidden = true;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // 2時間1分 一気に進める（25+5分 を3回、25分、そのあと4回目なので15分の長い休憩 → 長い休憩・残り9:00 のはず）
    await page.clock.fastForward(2 * 60 * MIN + MIN);

    await page.evaluate(() => {
      window.__hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(500);

    assert.equal(await text(page, '#mode'), '長い休憩');
    assert.equal(await text(page, '#count'), '4回');
    const left = toSeconds(await text(page, '#time'));
    assert.ok(left <= 9 * 60 && left >= 9 * 60 - 2, `残り時間が 9:00 前後のはず: ${left}秒`);
    assert.equal(await text(page, '#startBtn'), '一時停止');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('日付が変わると「今日の完了」は0回から数え直す', async () => {
  // 23:30 に作業開始 → 23:55 に1回目完了 → 0:00 に休憩終わり → 0:25 に2回目完了
  const { context, page, errors } = await openApp(env, { time: new Date('2026-11-02T23:30:00+09:00') });
  try {
    await page.click('#startBtn');
    await advance(page, 25 * MIN);
    assert.equal(await text(page, '#count'), '1回');

    await advance(page, 5 * MIN);
    await advance(page, 25 * MIN);
    // 日付が変わったので、昨日の1回は数えず「1回」
    assert.equal(await text(page, '#count'), '1回');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pomodoro-today')));
    assert.deepEqual(saved, { date: '2026-11-03', count: 1 });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('日付をまたいで戻ってきたら、表示も0回になる', async () => {
  const { context, page, errors } = await openApp(env, { time: new Date('2026-11-02T23:30:00+09:00') });
  try {
    await page.click('#startBtn');
    await advance(page, 25 * MIN);
    assert.equal(await text(page, '#count'), '1回');
    await page.click('#startBtn'); // 一時停止

    await page.clock.fastForward(20 * MIN); // 0:15 になる
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(await text(page, '#count'), '0回');

    await page.reload();
    assert.equal(await text(page, '#count'), '0回');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('お知らせの音: 作業が終わると上がる3音、休憩が終わると下がる3音（気付きやすいよう2回くり返す）', async () => {
  const { context, page, errors } = await openApp(env, { time: T0, initScripts: [recordNotesScript] });
  try {
    await page.click('#startBtn');
    await page.evaluate(() => { window.__notes = []; }); // 準備の音（無音）は数えない

    await advance(page, 25 * MIN);
    const up = await waitFor(page, () => window.__notes.length >= 6 && window.__notes.slice());
    assert.equal(up.length, 6, `3音×2回のはず: ${up}`);
    assert.deepEqual(up.slice(3), up.slice(0, 3), `同じ3音をくり返すはず: ${up}`);
    assert.ok(up[0] < up[1] && up[1] < up[2], `上がる音のはず: ${up}`);

    await page.evaluate(() => { window.__notes = []; });
    await advance(page, 5 * MIN);
    const down = await waitFor(page, () => window.__notes.length >= 6 && window.__notes.slice());
    assert.equal(down.length, 6, `3音×2回のはず: ${down}`);
    assert.deepEqual(down.slice(3), down.slice(0, 3), `同じ3音をくり返すはず: ${down}`);
    assert.ok(down[0] > down[1] && down[1] > down[2], `下がる音のはず: ${down}`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('読み込んだときにエラーが出ない', async () => {
  const { context, page, errors } = await openApp(env);
  const consoleErrors = [];
  page.on('console', (m) => {
    // 外部フォントを読みに行かないようにしているので、その失敗は数えない
    if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|ERR_FAILED/.test(m.text() + (m.location().url || ''))) {
      consoleErrors.push(m.text());
    }
  });
  try {
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(300);
    assert.deepEqual(errors, []);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await context.close();
  }
});

test('サービスワーカー: アプリのファイルを保存し、ネットがなくても開ける', async () => {
  // sw.js に書かれている APP_FILES の一覧を読み取る
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const list = sw.match(/APP_FILES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(list, 'sw.js に APP_FILES が見つからない');
  const appFiles = [...list[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(appFiles.length > 0);

  const { context, page, errors } = await openApp(env, { serviceWorkers: 'allow' });
  try {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await waitFor(page, () => !!navigator.serviceWorker.controller, undefined, 10_000);

    const cached = await page.evaluate(async () => {
      const urls = [];
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        for (const req of await cache.keys()) urls.push(req.url);
      }
      return urls;
    });
    for (const f of appFiles) {
      const url = new URL(f, env.url).href;
      assert.ok(cached.includes(url), `保存されていない: ${f}`);
    }

    await context.setOffline(true);
    await page.reload();
    assert.equal(await text(page, '#time'), '25:00');
    assert.equal(await text(page, '#startBtn'), 'スタート');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('動いている途中でアプリが閉じられても、開き直すと続きから動く', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await page.click('#startBtn');
    await advance(page, 10 * MIN);
    // ページを開き直す（スマホがアプリを閉じたのと同じ）。そのあいだに3分たつ
    await page.clock.fastForward(3 * MIN);
    await page.reload();
    await page.clock.runFor(500);
    assert.equal(await text(page, '#mode'), '作業');
    assert.equal(await text(page, '#startBtn'), '一時停止');
    const left = toSeconds(await text(page, '#time'));
    assert.ok(left <= 12 * 60 && left >= 12 * 60 - 2, `残り12:00前後のはず: ${left}秒`);

    // 閉じているあいだに作業が終わっていたら、回数も数えて休憩に進んでいる
    await page.clock.fastForward(14 * MIN);
    await page.reload();
    await page.clock.runFor(500);
    assert.equal(await text(page, '#mode'), '休憩');
    assert.equal(await text(page, '#count'), '1回');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('一時停止したまま閉じても、開き直すと残り時間を覚えている', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await page.click('#startBtn');
    await advance(page, 5 * MIN);
    await page.click('#startBtn');
    await page.clock.fastForward(60 * MIN);
    await page.reload();
    assert.equal(await text(page, '#startBtn'), '再開');
    assert.equal(await text(page, '#time'), '20:00');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('長い休憩が終わったら止まって待つ（つけっぱなしでも回数が増え続けない）', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await page.click('#startBtn');
    await page.clock.fastForward(10 * 60 * MIN);   // 10時間放っておく
    await page.clock.runFor(500);
    assert.equal(await text(page, '#count'), '4回');
    assert.equal(await text(page, '#mode'), '作業');
    assert.equal(await text(page, '#time'), '25:00');
    assert.equal(await text(page, '#startBtn'), 'スタート');
    assert.equal(await text(page, '#status'), 'おつかれさまでした。スタートで次の作業へ');
    assert.equal(await text(page, '#endsAt'), '');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('動いているあいだは、終わる時刻を表示する', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    assert.equal(await text(page, '#endsAt'), '');
    await page.click('#startBtn');
    assert.equal(await text(page, '#endsAt'), '10:25 に終わります');
    await advance(page, 25 * MIN);
    assert.equal(await text(page, '#endsAt'), '10:30 に終わります');
    await page.click('#startBtn');
    assert.equal(await text(page, '#endsAt'), '');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
