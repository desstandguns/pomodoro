// プッシュ通知：画面を消していても「時間になりました」を届けるための係
// index.html からは window.PomodoroPush を通して使います
// うまく動かないときも、タイマー本体は止まらないように作ってあります

(function () {
  // ===== 設定 =====
  // 通知サーバー（Cloudflare Workers）を公開したら、その URL をここに入れます
  // 例：'https://pomodoro-push.あなたの名前.workers.dev'
  // 空のままだと、通知の機能はまるごとお休みになります（何もしません）
  const PUSH_SERVER_URL = '';

  const SERVER = PUSH_SERVER_URL.replace(/\/+$/, '');   // 最後の「/」は取っておく
  const ENABLED_KEY = 'pomodoro-push';                  // オン・オフを覚えておく場所
  const VAPID_KEY = 'pomodoro-push-key';                // サーバーの鍵を覚えておく場所

  // ===== 小さな道具 =====
  function load(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function save(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) {}
  }

  // サーバーとのやりとり（10秒で返事がなければあきらめる）
  async function request(path, body) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 10000) : null;
    try {
      const options = { signal: ctrl ? ctrl.signal : undefined };
      if (body !== undefined) {
        options.method = 'POST';
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(body);
        options.keepalive = true;   // 画面を閉じた直後でも送りきれるように
      }
      const res = await fetch(SERVER + path, options);
      if (!res.ok) throw new Error(path + ' が ' + res.status + ' を返しました');
      return res;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // サーバーの鍵（文字）を、ブラウザが使える形（バイト列）に変える
  function keyToBytes(text) {
    const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
    const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }
  function sameBytes(a, b) {
    if (!a || !b || a.byteLength !== b.byteLength) return false;
    const x = new Uint8Array(a);
    const y = new Uint8Array(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  async function getVapidKey() {
    try {
      const res = await request('/vapid-public-key');
      const text = (await res.text()).trim();
      if (text) { save(VAPID_KEY, text); return text; }
    } catch (e) {
      console.warn('[push] 鍵を受け取れませんでした', e);
    }
    return load(VAPID_KEY);   // ネットがなければ、前に覚えた鍵を使う
  }

  // いまの登録（なければ null）
  async function getSubscription() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  // ===== 使えるかどうか =====
  function isSupported() {
    return !!SERVER &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window;
  }

  // iPhone・iPad の Safari で、ホーム画面から開いていないとき true
  // （iPhone では、ホーム画面に追加したアプリでしか通知が使えません）
  function needsHomeScreen() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!isIOS) return false;
    const standalone = navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    return !standalone;
  }

  function permission() {
    if (!isSupported()) return 'unsupported';
    return Notification.permission;   // 'granted' / 'denied' / 'default'
  }

  function isEnabled() {
    return isSupported() && load(ENABLED_KEY) === '1' && Notification.permission === 'granted';
  }

  // ===== オンにする（ボタンを押したときに呼ぶ） =====
  async function enable() {
    if (!isSupported()) return false;
    try {
      // 許可のたずね方は、ボタンを押した直後でないと iPhone では出ないので一番先に
      const result = await Notification.requestPermission();
      if (result !== 'granted') { save(ENABLED_KEY, null); return false; }

      const key = await getVapidKey();
      if (!key) return false;
      const keyBytes = keyToBytes(key);

      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      // サーバーの鍵が変わっていたら、登録をやり直す
      if (sub && sub.options && sub.options.applicationServerKey &&
          !sameBytes(sub.options.applicationServerKey, keyBytes.buffer)) {
        await sub.unsubscribe();
        sub = null;
      }
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });
      }
      save(ENABLED_KEY, '1');
      return true;
    } catch (e) {
      console.warn('[push] オンにできませんでした', e);
      save(ENABLED_KEY, null);
      return false;
    }
  }

  // ===== オフにする =====
  async function disable() {
    save(ENABLED_KEY, null);
    latest = null;   // まだ送っていない予約は取りやめ
    if (!isSupported()) return;
    try {
      const sub = await getSubscription();
      if (!sub) return;
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await request('/cancel', { endpoint: endpoint });
    } catch (e) {
      console.warn('[push] オフにする途中で失敗しました', e);
    }
  }

  // ===== 予約・取り消し =====
  // スタート・一時停止を素早くくり返しても順番が入れ替わらないように、
  // 送るのは1つずつ。待っているあいだに新しい指示が来たら、いちばん新しいものだけ送ります
  let latest = null;     // 次に送る指示
  let sending = false;   // いま送っている最中か

  async function flush() {
    if (sending) return;
    sending = true;
    try {
      while (latest) {
        const job = latest;
        latest = null;
        try {
          const sub = await getSubscription();
          if (!sub) { console.warn('[push] 登録が見つかりません'); continue; }
          if (job.type === 'schedule') {
            await request('/schedule', {
              subscription: sub.toJSON(),
              at: job.at,
              title: job.title,
              body: job.body,
              url: job.url
            });
          } else {
            await request('/cancel', { endpoint: sub.endpoint });
          }
        } catch (e) {
          console.warn('[push] サーバーに送れませんでした', e);
        }
      }
    } finally {
      sending = false;
    }
  }

  // 「at（ミリ秒の時刻）に通知して」とサーバーにお願いする
  function schedule(opts) {
    if (!isEnabled() || !opts) return;
    const at = Number(opts.at);
    if (!isFinite(at)) return;
    latest = {
      type: 'schedule',
      at: at,
      title: String(opts.title || 'ポモドーロ'),
      body: String(opts.body || '時間になりました'),
      url: location.href.split('#')[0]
    };
    flush();
  }

  // 予約していた通知を取り消す
  function cancel() {
    if (!isEnabled()) return;
    latest = { type: 'cancel' };
    flush();
  }

  window.PomodoroPush = {
    isSupported: isSupported,
    needsHomeScreen: needsHomeScreen,
    permission: permission,
    enable: enable,
    disable: disable,
    isEnabled: isEnabled,
    schedule: schedule,
    cancel: cancel
  };
})();
