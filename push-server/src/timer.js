// 1つの購読（スマホ1台のブラウザ）ごとの「予約」の出し入れと、時間が来たときの送信
import { sendPush, buildPayload } from './webpush.js';

const MAX_TRIES = 2;                 // 一時的な失敗のときのやり直し回数
const TOO_LATE_MS = 10 * 60 * 1000;  // 10分以上遅れたら送らない

// 予約する（前の予約は上書き）
export async function scheduleJob(storage, job) {
  await storage.put('job', { ...job, tries: 0 });
  await storage.setAlarm(job.at);
}

// 予約を消す（何度呼んでも大丈夫）
export async function clearJob(storage) {
  await storage.deleteAlarm();
  await storage.deleteAll();
}

// 時間になったら呼ばれる
export async function runAlarm(storage, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const job = await storage.get('job');
  if (!job) return 'none';
  if (now - job.at > TOO_LATE_MS) { await clearJob(storage); return 'expired'; }

  let res = null;
  try {
    res = await sendPush({ subscription: job.subscription, payload: buildPayload(job), env, fetchImpl });
  } catch (e) {
    console.log('送信エラー', String(e));
  }

  if (res && res.ok) { await clearJob(storage); return 'sent'; }
  // 404・410 は「この購読はもう使えない」という意味なので、保存分を消す
  if (res && (res.status === 404 || res.status === 410)) { await clearJob(storage); return 'gone'; }

  // 通信エラー・混雑（429）・相手側の故障（5xx）は少し待ってやり直す
  const retryable = !res || res.status === 429 || res.status >= 500;
  const tries = job.tries || 0;
  if (retryable && tries < MAX_TRIES) {
    await storage.put('job', { ...job, tries: tries + 1 });
    await storage.setAlarm(now + 5000 * (tries + 1));
    return 'retry';
  }
  if (res) console.log('送信失敗', res.status, await res.text().catch(() => ''));
  await clearJob(storage);
  return 'failed';
}
