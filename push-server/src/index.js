// Cloudflare Workers の入口
import { DurableObject } from 'cloudflare:workers';
import { handleRequest } from './app.js';
import { scheduleJob, clearJob, runAlarm } from './timer.js';

// 購読1つにつき1つできる「タイマー係」。決めた時刻にアラームで起きて通知を送る
export class PushTimer extends DurableObject {
  async schedule(job) {
    await scheduleJob(this.ctx.storage, job);
  }

  async cancel() {
    await clearJob(this.ctx.storage);
  }

  async alarm() {
    await runAlarm(this.ctx.storage, this.env);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  }
};
