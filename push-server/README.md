# 通知サーバー（push-server）

ポモドーロタイマーの「時間になりました」を、**スマホの画面が消えていても**通知で知らせるための、小さなサーバーです。
Cloudflare（クラウドフレア）という会社の **無料プラン** の上で動かします。お金はかかりません。

---

## これは何をするもの？

iPhone は、画面を消すとブラウザ（アプリ）の動きを止めてしまいます。
そのため、アプリだけでは「25分たったよ」と知らせることができません。

そこで、こうします。

```
① スタートを押す
   スマホ ──「25分後に知らせて」──▶ 通知サーバー（このフォルダ）
                                         │  25分待つ
② 時間になる                               ▼
   スマホ ◀── Apple の通知のしくみ ◀──「時間です」
   （画面が消えていても通知が届く）
```

- 一時停止やリセットを押したときは、アプリが「さっきの予約は取り消して」とサーバーに伝えます。
- 通知を押すと、タイマーのページが開きます。

---

## ことばの説明

| ことば | 意味 |
| --- | --- |
| サーバー | インターネット上で24時間動いている、小さなコンピューターのようなもの |
| Cloudflare Workers（ワーカーズ） | Cloudflare が無料で貸してくれる「プログラムを置く場所」 |
| Durable Object（デュラブル・オブジェクト） | Workers の中の「覚えておく係」。ここでは **スマホ1台ごとに1つの目覚まし時計** として使っています |
| アラーム | Durable Object の目覚まし機能。決めた時刻に起きて、通知を送ります |
| Web Push（ウェブ・プッシュ） | ブラウザに通知を届けるしくみ。実際に届けるのは Apple や Google のサーバー |
| VAPID 鍵（ヴェイピッド・かぎ） | 「この通知は本物の送り主から来た」と証明するための **鍵のペア**。公開鍵（見せてよい方）と秘密鍵（絶対に見せない方）があります |
| シークレット | Cloudflare に預ける「秘密の設定」。ファイルには書かず、安全な場所に保存されます |
| デプロイ | 作ったプログラムを Cloudflare に送って、動かし始めること |
| ターミナル | 文字でパソコンに命令を出す画面。Windows では「PowerShell（パワーシェル）」を使います |
| CORS（コルス） | 「どのサイトからこのサーバーを使ってよいか」の決まり。あなたのタイマーのサイト以外からは使えないようにしています |

---

## 用意するもの

1. **Node.js（ノード・ジェイエス）**
   - https://nodejs.org/ を開き、「LTS」と書かれた方をダウンロードして、インストールします（全部「次へ」で大丈夫）。
   - インストールできたか確かめる：PowerShell を開いて `node -v` と打ち、Enter。`v22.…` のような数字が出れば OK。
2. **Cloudflare のアカウント（無料）**
   - https://dash.cloudflare.com/sign-up を開き、メールアドレスとパスワードで登録します。
   - 届いた確認メールのリンクを押しておきます。
3. **このリポジトリ（pomodoro フォルダ）がパソコンにあること**

> PowerShell の開き方：スタートボタンを右クリック →「ターミナル」または「Windows PowerShell」。

---

## 使えるようにする手順（はじめの1回だけ）

以下のコマンドは、PowerShell に **1行ずつ** 貼り付けて Enter を押します。

### 手順1：このフォルダに移動する

```powershell
cd C:\（pomodoro フォルダがある場所）\pomodoro\push-server
```

> エクスプローラーで `push-server` フォルダを開き、上のアドレス欄に `powershell` と打って Enter しても、そのフォルダで PowerShell が開きます。

### 手順2：Cloudflare にログインする

```powershell
npx wrangler login
```

- 初めてのときは「Need to install the following packages… Ok to proceed? (y)」と聞かれるので `y` を押して Enter。
  （`wrangler`（ラングラー）は、Cloudflare を操作するための道具です）
- ブラウザが開くので「Allow（許可）」を押します。
- PowerShell に「Successfully logged in」と出れば OK。

### 手順3：プログラムを Cloudflare に送る（デプロイ）

```powershell
npx wrangler deploy
```

- 初めてのときは「workers.dev のサブドメイン（あなた専用の名前）を登録しますか？」と聞かれることがあります。好きな英数字の名前を決めて登録してください。
- 最後に、次のような **https://〜.workers.dev** のアドレスが表示されます。これが **通知サーバーのアドレス** です。メモしておきましょう。

```
Deployed pomodoro-push triggers
  https://pomodoro-push.あなたの名前.workers.dev
```

> あとから確かめたいとき：https://dash.cloudflare.com を開き、左のメニュー「Workers & Pages（ワーカーとページ）」→「pomodoro-push」を開くと、アドレスが書いてあります。

### 手順4：VAPID 鍵を作る

```powershell
node scripts/generate-vapid-keys.mjs
```

次のような2行が出ます（中身は毎回ちがいます）。

```
VAPID_PUBLIC_KEY=BJ_5YIG1…（長い英数字）
VAPID_PRIVATE_KEY=n1wGGT7o…（短めの英数字）
```

- `=` の **右側だけ** を、次の手順で使います。
- **VAPID_PRIVATE_KEY（秘密鍵）は、だれにも見せないでください。** ファイルに保存したり、GitHub に上げたりもしないでください。
- この画面は、手順5が終わるまで閉じないでおきましょう。

### 手順5：鍵を Cloudflare に預ける（シークレット）

```powershell
npx wrangler secret put VAPID_PUBLIC_KEY
```

「Enter a secret value:」と出たら、手順4の **VAPID_PUBLIC_KEY の右側** を貼り付けて Enter。
（貼り付けても画面には何も表示されませんが、ちゃんと入っています）

続けて、もう1つ。

```powershell
npx wrangler secret put VAPID_PRIVATE_KEY
```

同じように、**VAPID_PRIVATE_KEY の右側** を貼り付けて Enter。

> 鍵を作り直したときは、手順5をもう一度やれば上書きされます。
> ただし、鍵を変えると、スマホ側でもう一度「通知を許可」し直す必要があります。

### 手順6：動いているか確かめる

ブラウザで、手順3のアドレスの後ろに `/vapid-public-key` を付けて開きます。

```
https://pomodoro-push.あなたの名前.workers.dev/vapid-public-key
```

手順4の **VAPID_PUBLIC_KEY と同じ文字** が表示されれば成功です。
（アドレスだけを開くと「動いています」と表示されます）

### 手順7：アプリにサーバーのアドレスを書く

タイマーアプリの `push.js` を開き、`PUSH_SERVER_URL` のところに、手順3のアドレスを書きます。

```js
const PUSH_SERVER_URL = 'https://pomodoro-push.あなたの名前.workers.dev';
```

- 最後に `/` は付けません。
- 保存して GitHub に上げれば、数分後にアプリに反映されます。

これで準備は完了です。

---

## 設定を変えたいとき

設定は `wrangler.jsonc` の `"vars"` のところに書いてあります。変えたら `npx wrangler deploy` をもう一度実行してください。

### GitHub のユーザー名が変わったとき（ALLOWED_ORIGIN）

`ALLOWED_ORIGIN` は「このサーバーを使ってよいサイト」です。今はこうなっています。

```jsonc
"ALLOWED_ORIGIN": "https://desstandguns.github.io",
```

- ユーザー名が変わったら、`https://新しいユーザー名.github.io` に書き換えます。
- **`/pomodoro/` は付けません。** `https://〜.github.io` までです。
- 2つ以上のサイトを許可したいときは、カンマ `,` で区切って並べます。
- 通知を押したときに開くページも、ここに書いたサイトの中だけに限られます。

### VAPID_SUBJECT（送り主の連絡先）

Apple や Google が「この通知の送り主はだれか」を知るための連絡先です。
今はタイマーのサイトのアドレスを入れてあります（`https://` の URL か `mailto:` で始まるメールアドレスが使えます）。
ユーザー名が変わったら、ここも一緒に書き換えてください。

---

## 無料で使える量

Cloudflare の無料プランでは、1日あたり次の量まで無料です（日本時間の朝9時にリセット）。

- Workers への呼び出し：10万回／日
- Durable Object への呼び出し（アラームを含む）：10万回／日

ポモドーロ1回で数回しか使わないので、ひとりで使うなら、まず超えることはありません。
もし超えても、お金は取られず、その日の残りは通知が届かなくなるだけです。

---

## うまくいかないとき

| こまったこと | ためしてみること |
| --- | --- |
| `npx` が見つからないと言われる | Node.js をインストールし直し、PowerShell を開き直す |
| 手順6で何も表示されない | 手順5をやり直す（貼り付けたときに余計な空白が入っていないか） |
| 通知が来ない | iPhone は iOS 16.4 以上で、タイマーを **ホーム画面に追加したアプリから** 開き、通知を「許可」している必要があります |
| アプリで「このサイトからは使えません」と出る | `ALLOWED_ORIGIN` のつづり・最後の `/` を確認して、もう一度デプロイ |
| エラーの中身を見たい | PowerShell で `npx wrangler tail` を実行すると、サーバーの動きがリアルタイムで見えます（Ctrl + C で終了） |

---

## 開発者向けメモ

### ファイル

```
push-server/
├─ wrangler.jsonc                Cloudflare の設定
├─ src/index.js                  入口と Durable Object（PushTimer）
├─ src/app.js                    URL ごとの受付と CORS
├─ src/validate.js               入力のチェック
├─ src/timer.js                  予約の保存・アラームでの送信・やり直し
├─ src/webpush.js                VAPID（ES256 JWT）と RFC 8291 aes128gcm 暗号化（WebCrypto のみ）
├─ src/base64.js                 base64url
├─ scripts/generate-vapid-keys.mjs  鍵の作成
└─ test/                         node --test で動くテスト
```

### API

| | 内容 |
| --- | --- |
| `GET /vapid-public-key` | 200 `text/plain`。URL-safe base64 の公開鍵 |
| `POST /schedule` | JSON `{"subscription": PushSubscription.toJSON(), "at": エポックミリ秒, "title": 文字列, "body": 文字列, "url": 文字列}` → 200 `{"ok":true}`。同じ endpoint の前の予約は上書き |
| `POST /cancel` | JSON `{"endpoint": 文字列}` → 200 `{"ok":true}`。何度呼んでも OK |

チェック内容（違反は 400 `{"ok":false,"error":"…"}`）：

- `at` は「今 −60秒」〜「今 +3時間」
- `title` 1〜100文字、`body` 0〜200文字
- `url` は `ALLOWED_ORIGIN` のサイト内の、`https://` から始まる完全な URL
- `endpoint` は https で、Apple / Google（FCM）/ Mozilla / Microsoft の通知サーバーのもの
- `ALLOWED_ORIGIN` 以外の Origin は 403（`GET /vapid-public-key` と `GET /` だけは Origin なしでも見られる）

送る通知の中身（Declarative Web Push 形式。サービスワーカーでも `JSON.parse` して使える）：

```json
{"web_push": 8030, "notification": {"title": "…", "body": "…", "navigate": "…", "tag": "pomodoro", "silent": false}}
```

ヘッダーは `TTL: 600`、`Urgency: high`。通知サービスが 404 / 410 を返したら、その購読の保存分を消します。
通信エラー・429・5xx は 5秒後・10秒後に2回までやり直し、予定時刻から10分以上遅れたものは送りません。

### テスト

インストール不要です（Node.js 18 以上）。

```powershell
node --test
```

RFC 8291 付録A の例との一致、暗号を受け取り側として復号できること、JWT の署名確認、入力チェック、CORS、
アラーム時の送信・404/410 での削除・やり直しを確かめています。
