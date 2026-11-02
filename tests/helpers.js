// テストで共通に使う道具（小さなファイルサーバー、ブラウザの起動など）
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// リポジトリのフォルダをそのまま配信する、とても小さなサーバー
function startServer() {
  const server = http.createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.normalize(path.join(ROOT, pathname));
    if (!file.startsWith(ROOT + path.sep) || file.includes(`${path.sep}.git`)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      // サービスワーカーは http://localhost なら動くので localhost を使う
      resolve({ server, url: `http://localhost:${port}/` });
    });
  });
}

// テストファイルごとに「サーバー＋ブラウザ」を1つ用意する
function setup(test) {
  const env = { browser: null, server: null, url: null };
  test.before(async () => {
    const s = await startServer();
    env.server = s.server;
    env.url = s.url;
    env.browser = await chromium.launch();
  });
  test.after(async () => {
    if (env.browser) await env.browser.close();
    if (env.server) await new Promise((r) => env.server.close(r));
  });
  return env;
}

// テストごとに新しい「まっさらなブラウザ」（localStorage も空）を作る
// opts.time を渡すと時計を偽物にして、その時刻から始める
async function openApp(env, opts = {}) {
  const context = await env.browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    serviceWorkers: opts.serviceWorkers || 'block',
  });
  // 外部の文字デザイン（Google Fonts）は読みに行かない（ネットがなくても同じ結果にするため）
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  for (const script of opts.initScripts || []) await page.addInitScript(script);
  if (opts.time !== undefined) await page.clock.install({ time: opts.time });
  await page.goto(env.url);
  return { context, page, errors };
}

const text = (page, sel) => page.locator(sel).innerText();

// "MM:SS" を秒に直す
function toSeconds(mmss) {
  const [m, s] = mmss.trim().split(':').map(Number);
  return m * 60 + s;
}

const MIN = 60 * 1000;

// 音の記録：AudioContext の発振器が鳴らした周波数を window.__notes に残す
const recordNotesScript = () => {
  window.__notes = [];
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const orig = AC.prototype.createOscillator;
  AC.prototype.createOscillator = function () {
    const osc = orig.call(this);
    const origStart = osc.start.bind(osc);
    osc.start = (...args) => {
      window.__notes.push(osc.frequency.value);
      return origStart(...args);
    };
    return osc;
  };
};

module.exports = { setup, openApp, text, toSeconds, MIN, recordNotesScript, ROOT };

// ページの中の条件が true になるまで待つ（偽物の時計を入れていても使える待ち方）
async function waitFor(page, fn, arg, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(fn, arg);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out: ' + fn.toString());
    await new Promise((r) => setTimeout(r, 30));
  }
}

module.exports.waitFor = waitFor;

// 時計を ms だけ進める。ほとんどは一気に飛ばし（速い）、最後の1秒だけ1コマずつ動かす。
// runFor だけで何十分も進めると、とても時間がかかるため。
async function advance(page, ms) {
  const tail = Math.min(ms, 1000);
  if (ms > tail) await page.clock.fastForward(ms - tail);
  await page.clock.runFor(tail);
}

module.exports.advance = advance;
