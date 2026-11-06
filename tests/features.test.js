// 設定・早めに完了・いまやること・記録・バックアップなど、あとから足した機能のテスト
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setup, openApp, text, toSeconds, MIN, recordNotesScript, waitFor, advance } = require('./helpers');

const env = setup(test);
const T0 = new Date('2026-11-06T10:00:00+09:00');

async function openSettings(page) {
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsDialog[open]');
}
async function closeSettings(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('#settingsDialog:not([open])', { state: 'attached' });
}

test('設定: 開いて変えると覚えていて、開き直しても同じ', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await openSettings(page);
    assert.equal(await page.isChecked('#optAutoNext'), true);
    assert.equal(await page.isChecked('input[name="sound"][value="chime"]'), true);
    await page.click('#optAutoNext');
    await page.check('input[name="sound"][value="bell"]');
    await page.check('input[name="volume"][value="3"]');
    await page.check('input[name="goal"][value="6"]');
    await closeSettings(page);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pomodoro-settings')));
    assert.deepEqual(saved, { autoNext: false, repeat: true, wake: true, sound: 'bell', volume: 3, goal: 6 });
    await page.reload();
    await openSettings(page);
    assert.equal(await page.isChecked('#optAutoNext'), false);
    assert.equal(await page.isChecked('input[name="goal"][value="6"]'), true);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('自動で次に進む：オフなら、作業が終わると休憩の最初で止まって待つ', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await page.evaluate(() => localStorage.setItem('pomodoro-settings', JSON.stringify({ autoNext: false })));
    await page.reload();
    await page.click('#startBtn');
    await advance(page, 25 * MIN);
    assert.equal(await text(page, '#mode'), '休憩');
    assert.equal(await text(page, '#time'), '05:00');
    assert.equal(await text(page, '#startBtn'), 'スタート');
    assert.equal(await text(page, '#count'), '1回');
    await advance(page, 10 * MIN);   // 待っているあいだは進まない
    assert.equal(await text(page, '#time'), '05:00');
    await page.click('#startBtn');
    await advance(page, 5 * MIN);
    assert.equal(await text(page, '#mode'), '作業');
    assert.equal(await text(page, '#startBtn'), 'スタート');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('早めに完了：やった分数で記録して休憩へ。始める前は押せない', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    assert.equal(await text(page, '#skipBtn'), '早めに完了');
    assert.equal(await page.isDisabled('#skipBtn'), true);
    await page.click('#startBtn');
    await advance(page, 12 * MIN);
    await page.click('#skipBtn');
    assert.equal(await text(page, '#mode'), '休憩');
    assert.equal(await text(page, '#count'), '1回');
    assert.equal(await text(page, '#startBtn'), '一時停止');   // 動いていたら休憩もそのまま始まる
    assert.equal(await text(page, '#skipBtn'), '休憩をとばす');
    const minutes = await page.evaluate(() => JSON.parse(localStorage.getItem('pomodoro-minutes')));
    assert.deepEqual(minutes, { '2026-11-06': 12 });

    // 休憩をとばす → 作業へ（回数は増えない）
    await page.click('#skipBtn');
    assert.equal(await text(page, '#mode'), '作業');
    assert.equal(await text(page, '#time'), '25:00');
    assert.equal(await text(page, '#count'), '1回');
    assert.equal(await text(page, '#cycle'), '2/4');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('長い休憩をとばすと、止まって次の4回を待つ', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await page.click('#startBtn');
    for (let i = 0; i < 3; i++) {
      await advance(page, 25 * MIN);
      await advance(page, 5 * MIN);
    }
    await advance(page, 25 * MIN);
    assert.equal(await text(page, '#mode'), '長い休憩');
    await page.click('#skipBtn');
    assert.equal(await text(page, '#mode'), '作業');
    assert.equal(await text(page, '#startBtn'), 'スタート');
    assert.equal(await text(page, '#cycle'), '1/4');
    assert.equal(await text(page, '#status'), 'おつかれさまでした。スタートで次の作業へ');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('いまやること：覚えていて、終わった作業と一緒に記録に残る', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await page.fill('#taskInput', '企画書の下書き');
    await page.reload();
    assert.equal(await page.inputValue('#taskInput'), '企画書の下書き');
    await page.click('#startBtn');
    await advance(page, 25 * MIN);
    const log = await page.evaluate(() => JSON.parse(localStorage.getItem('pomodoro-log')));
    assert.equal(log.length, 1);
    assert.equal(log[0].task, '企画書の下書き');
    assert.equal(log[0].min, 25);
    assert.ok(Math.abs(log[0].at - (T0.getTime() + 25 * MIN)) < 2000, `終わった時刻: ${log[0].at}`);

    await page.click('#historyPanel summary');
    const items = await page.$$eval('#recentLog li', (lis) => lis.map((li) => li.innerText.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(items, ['11/6 10:25・25分 企画書の下書き']);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('いまやること：文字はそのまま文字として表示する（HTML として動かない）', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await page.fill('#taskInput', '<img src=x onerror="window.__bad=1">');
    await page.click('#startBtn');
    await advance(page, 25 * MIN);
    await page.click('#historyPanel summary');
    assert.equal(await page.$('#recentLog img'), null);
    assert.equal(await page.evaluate(() => window.__bad), undefined);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('記録: 連続日数を数える（今日まだなら昨日まで）', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await page.evaluate(() => localStorage.setItem('pomodoro-history', JSON.stringify({
      '2026-11-02': 3, '2026-11-03': 0, '2026-11-04': 2, '2026-11-05': 5,
    })));
    await page.reload();
    await page.click('#historyPanel summary');
    assert.equal(await text(page, '#streak'), '2日');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('目標: 点と「1/4回」で進み具合を出し、届いたら「目標達成」', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await page.evaluate(() => {
      localStorage.setItem('pomodoro-settings', JSON.stringify({ goal: 4 }));
      localStorage.setItem('pomodoro-today', JSON.stringify({ date: '2026-11-06', count: 3 }));
    });
    await page.reload();
    assert.equal(await text(page, '#count'), '3/4回');
    assert.equal(await page.$$eval('#dots span', (s) => s.length), 4);
    assert.equal(await page.$$eval('#dots span.off', (s) => s.length), 1);
    assert.equal(await text(page, '#todayLabel'), '今日の完了');
    await page.click('#startBtn');
    await advance(page, 25 * MIN);
    assert.equal(await text(page, '#count'), '4/4回');
    assert.equal(await text(page, '#todayLabel'), '目標達成');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('閉じているあいだに日付をまたいで終わった回は、終わった日の記録に入る', async () => {
  const { context, page, errors } = await openApp(env, { time: new Date('2026-11-05T23:50:00+09:00') });
  try {
    await page.click('#startBtn');   // 0:15 に作業が終わる
    await page.clock.fastForward(5 * MIN);
    await page.reload();
    await page.clock.fastForward(5 * MIN);   // 0:00 をこえる（まだ作業中）
    await page.reload();
    await page.clock.fastForward(30 * MIN);  // 0:30（作業は 0:15 に終わり、休憩中）
    await page.reload();
    await page.clock.runFor(500);
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('pomodoro-history')));
    assert.deepEqual(history, { '2026-11-06': 1 });
    assert.equal(await text(page, '#count'), '1回');

    // もう一例：前の日（23:55）に終わっていた回は前の日へ入る（そのあと今日の分も進む）
    await page.evaluate(() => {
      localStorage.setItem('pomodoro-state', JSON.stringify({
        workMin: 25, phase: 'work', done: 0, endTime: new Date('2026-11-05T23:55:00+09:00').getTime(), remaining: null,
      }));
    });
    await page.reload();
    await page.clock.runFor(500);
    const h2 = await page.evaluate(() => JSON.parse(localStorage.getItem('pomodoro-history')));
    assert.equal(h2['2026-11-05'], 1);
    assert.equal(Number(await text(page, '#count').then((t) => parseInt(t, 10))), h2['2026-11-06']);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('ずっと前に終わっていた回では、開いたときに音を鳴らさない', async () => {
  const { context, page, errors } = await openApp(env, { time: T0, initScripts: [recordNotesScript] });
  try {
    await page.click('#startBtn');
    await page.clock.fastForward(40 * MIN);   // 作業は15分前に終わっている
    await page.reload();
    await page.clock.runFor(3000);
    assert.equal(await page.isVisible('#stopAlarmBtn'), false);
    assert.equal(await text(page, '#count'), '1回');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('気付くまで音をくり返す：オフなら1回だけ鳴る', async () => {
  const { context, page, errors } = await openApp(env, { time: T0, initScripts: [recordNotesScript] });
  try {
    await page.evaluate(() => localStorage.setItem('pomodoro-settings', JSON.stringify({ repeat: false })));
    await page.reload();
    await page.click('#startBtn');
    await page.evaluate(() => { window.__notes = []; });
    await advance(page, 25 * MIN);
    await page.clock.runFor(10 * 1000);
    assert.equal(await page.evaluate(() => window.__notes.length), 3);
    assert.equal(await page.isVisible('#stopAlarmBtn'), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('音の種類：ベルとピピッも鳴る', async () => {
  const { context, page, errors } = await openApp(env, { time: T0, initScripts: [recordNotesScript] });
  try {
    for (const [sound, n] of [['bell', 6], ['beep', 6]]) {
      await page.evaluate((s) => localStorage.setItem('pomodoro-settings', JSON.stringify({ sound: s })), sound);
      await page.reload();
      await page.evaluate(() => { window.__notes = []; });
      await page.click('#testSoundBtn');
      const notes = await waitFor(page, (k) => window.__notes.length >= k && window.__notes.slice(), n);
      assert.equal(notes.length, n, `${sound}: ${notes}`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('バックアップ：書き出したファイルを読み込むと、記録と設定が戻る', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await page.evaluate(() => {
      localStorage.setItem('pomodoro-history', JSON.stringify({ '2026-11-05': 7 }));
      localStorage.setItem('pomodoro-settings', JSON.stringify({ goal: 8 }));
      localStorage.setItem('pomodoro-push', '1');   // 通知の登録は入れない
    });
    await page.reload();
    await openSettings(page);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-')), 'backup.json');
    await download.saveAs(file);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(json.app, 'pomodoro');
    assert.equal(json.data['pomodoro-history'], JSON.stringify({ '2026-11-05': 7 }));
    assert.equal(json.data['pomodoro-push'], undefined);

    // 記録を消してから読み込む
    await page.evaluate(() => { localStorage.removeItem('pomodoro-history'); localStorage.removeItem('pomodoro-settings'); });
    page.once('dialog', (d) => d.accept());
    await Promise.all([page.waitForEvent('load'), page.setInputFiles('#importFile', file)]);
    const restored = await page.evaluate(() => [localStorage.getItem('pomodoro-history'), localStorage.getItem('pomodoro-settings')]);
    assert.deepEqual(restored, [JSON.stringify({ '2026-11-05': 7 }), JSON.stringify({ goal: 8 })]);
    assert.equal(await text(page, '#count'), '0/8回');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('バックアップ：関係ないファイルは読み込まない', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await openSettings(page);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-')), 'other.json');
    fs.writeFileSync(file, JSON.stringify({ hello: 'world' }));
    await page.setInputFiles('#importFile', file);
    await waitFor(page, () => document.getElementById('backupMsg').textContent !== '');
    assert.equal(await text(page, '#backupMsg'), 'このファイルは読み込めませんでした');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('小さいスマホ（360×640）でも、記録を閉じていればスクロールなしで収まる', async () => {
  const { context, page, errors } = await openApp(env, { time: T0 });
  try {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.evaluate(() => localStorage.setItem('pomodoro-settings', JSON.stringify({ goal: 12 })));
    await page.reload();
    const [scroll, inner, mainScroll, mainClient] = await page.evaluate(() => [
      document.scrollingElement.scrollHeight, innerHeight,
      document.querySelector('main').scrollHeight, document.querySelector('main').clientHeight,
    ]);
    assert.ok(scroll <= inner && mainScroll <= mainClient, `${scroll}/${inner} ${mainScroll}/${mainClient}`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
