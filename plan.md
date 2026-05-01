# 開発コード
headlenss。後ほど変更するかもしれません。

# これは何か

- Even G2からClaude Codeへ指示を出せる、出力をレンズに表示できるようにする。
- 母艦となるPCに対して、tailscaleを用いてWebからアクセスができる。
- tailscale内の端末同士でやりとりをする前提。
- G2からの音声入力/テキスト出力だけじゃなく、Webブラウザからtmuxをアクセスできるようにする。

# システム構成(全体像)

```
G2(マイク + ディスプレイ + タッチパッド)
   ↕ BLE 5.2
スマホ(Even Realities アプリ = Flutter WebView)
   └─ G2用Webアプリ(even/ の中身、TS+Vite)
        ├─ HTTPS → Speechmatics REST (音声 → テキスト)
        └─ HTTP/WS → 母艦PC (tailscale経由)
母艦PC(server/ の中身、Hono + tmux + Claude Code)
   ↕ HTTP/WS
ブラウザ(スマホ/PC、Web画面)
```

- G2本体ではJSは動かない。表示・入力・音声キャプチャの末端デバイス。
- G2アプリは「ペアリングしたスマホ上のWebView」で動作する(Even Hub SDKの制約)。
- ASRはG2アプリから直接Speechmaticsに投げる構成 (API keyはWebView上で入力・保存)。
  - 母艦サーバには音声を送らない。テキストだけが `POST /api/sessions/:name/input` に流れる。
  - 母艦サーバの `/api/asr` (whisper-cpp / amivoice / speechmatics) は Web UI から手動文字起こしする用途として残す。
- 母艦PCはサーバー、tmuxホスト、Claude Code実行環境を兼ねる。
- スマホは常時稼働の中継ハブとして動作する前提。

# Webページ

スマホとPC、両方に対応したレイアウト。

- ルート画面 : 現在有効なtmuxの一覧が表示される。tmuxの新規追加と削除も可能。
- tmux画面 : tmuxを開いた画面。

# マスターエージェント
ルート画面にいる専属のエージェント。これもtmux内で起動されているClaude Code。
基本的には各tmux内にいるエージェントに指示を与えるが、マスターエージェントからtmuxへ指示を伝達してもらうケースもある。

初期実装(MVP)では後回しとし、まずは普通のtmuxセッション管理として動かす。
セッション間の指示伝達(`tmux send-keys` 経由)は、マスターエージェント機能を組み込むフェーズで別途設計する。

# フォルダ構成

- even : Even G2用のアプリ(スマホWebView上で動くTypeScript Webアプリ)
- server : 母艦PC側のサーバー実装

# 技術選定

## server(母艦PC)
- ランタイム/言語 : Node.js + TypeScript
- フレームワーク : Hono(HTTP API + WebSocket)
- tmux制御 : tmux CLI + node-pty 併用
  - 一覧/作成/削除は tmux CLI を子プロセスで実行
  - ターミナル中継は node-pty 経由で `tmux attach` を開く
- 音声認識(ASR) : whisper.cpp(ローカル)
  - G2マイクで取得した PCM 16kHz / 16bit / mono / S16LE をそのまま受け取って文字起こし
- TLS : `tailscale cert <hostname>.<tailnet>.ts.net` で発行した証明書でHTTPS化
  - G2アプリ(WebView)からのmixed-content回避と、CORSヘッダー必須のため
- CORS : G2アプリのoriginを許可する設定
- 認証 : なし(tailnet 内アクセス前提、ACL に任せる)

## Web画面(server/web)
- ビルド : Vite
- フレームワーク : React
- ターミナル表示 : xterm.js
- レイアウト : スマホ/PC両対応(レスポンシブ)

## even(G2アプリ)
- 実行環境 : ペアリングしたスマホのEven Realitiesアプリ(Flutter WebView上)
- 言語 : TypeScript
- ビルド : Vite
- SDK : `@evenrealities/even_hub_sdk`
- CLI : `@evenrealities/evenhub-cli`(`evenhub init` / `qr` / `pack`)
- 起点テンプレート : 公式 `asr` テンプレート(マイク→STT→表示の雛形)
- パッケージング : `evenhub pack` で `.ehpk` を生成
- app.json
  - `network` permission の whitelist に母艦ホスト(`https://<host>.<tailnet>.ts.net`)を記載
  - `g2-microphone` permission を宣言
- 開発環境 : `@evenrealities/evenhub-simulator` で実機なし開発
- バックグラウンド対応 : `setBackgroundState` / `onBackgroundRestore` を初期から組み込む
  - スマホがバックグラウンドに行っても headless WebView で動作継続するが、JS state は明示的に保存しないと消える
- 永続化 : `bridge.setLocalStorage` / `getLocalStorage`(browser localStorage / IndexedDB は不可)

# G2ハードウェア仕様(設計に効く前提)

- ディスプレイ : 576×288、4-bit greyscale(緑単色16階調)
  - 最大12コンテナ(text/list 8 + image 4)
  - テキスト1ページ ~400-500文字、`textContainerUpgrade` 1回で最大2000文字
  - LVGLフォント固定、サイズ・太さ調整不可
- マイク : G2本体4マイクアレイ。SDK経由で 16kHz / 16bit / mono / S16LE PCM
- 入力 : 両テンプルのタッチパッド(クリック/ダブルクリック/上下スワイプ)、IMU、R1リング(オプション)
- スピーカー : 無し
- カメラ : 無し
- 通信 : Bluetooth 5.2 のみ(Wi-Fi無し)
- スマホ必須 : 公式SDKパスではスマホ経由が必須

# 通信プロトコル(暫定方針)

- 母艦PC ↔ Web画面 : HTTP API + WebSocket(xterm.js のターミナル中継)
- G2アプリ ↔ Speechmatics : **Realtime WebSocket API (直接接続)**
  - 一時 JWT 発行: `POST https://mp.speechmatics.com/v1/api_keys?type=rt` (CORS 全公開なのでブラウザ直叩き可)
  - 接続: `wss://eu.rt.speechmatics.com/v2?jwt=<...>`
  - StartRecognition (audio_format=pcm_s16le 16kHz mono) → AddAudio バイナリチャンク連投 → EndOfStream
  - AddPartialTranscript / AddTranscript を受信、レイテンシは partial <500ms / final 1〜2s (`max_delay:1.0`)
  - API keyはWebViewのフォームで入力し localStorage + bridge.setLocalStorage に保存
- G2アプリ ↔ 母艦PC : HTTP API
  - テキスト送信: `POST /api/sessions/:name/input` (`{text, submit}`) で tmux に流し込む
  - セッション一覧: `GET /api/sessions`
  - 将来案: 母艦PCからレンズへのpush (WS or SSE) で `textContainerUpgrade` を駆動
  - WSが whitelist や CORS で問題が出る場合は SSE / fetch ストリーミングに切り替え検討

# 検証が必要な未確定事項

- WebView の `network` permission whitelist が `wss://` を許容するか
- tailscale ホスト(`<host>.<tailnet>.ts.net`)が whitelist で通るか
- iOS / Android のローカルネットワーク許可ダイアログの挙動
- 長文出力の page flip UX(~400-500文字ごとにユーザーがスワイプで進める想定)

# 開発の進め方

1. server/ から先に着手。tmuxセッション管理API + Web画面 + xterm.js中継。 ✅
2. whisper.cppセットアップと `POST /api/asr`(or WS版)エンドポイント。 ✅ (Web UI経由用に残す)
3. even/ を実装。録音→Speechmatics RT→ tmux send-keys のフローを確立 (リアルタイムで partial を G2 レンズに表示しながら、確定で tmux 送信)。 ✅
4. 実機G2でマイク精度・表示・タッチ操作を検証。
5. レンズへの双方向 push (tmux 出力 → G2画面) を組み込み。
6. マスターエージェント機能を組み込み(後追い)。

# 参考リソース

- 公式docs : https://hub.evenrealities.com/docs
- SDK : https://www.npmjs.com/package/@evenrealities/even_hub_sdk
- 公式テンプレート : https://github.com/even-realities/evenhub-templates
- コミュニティRコンポーネント集 : https://github.com/fabioglimb/even-toolkit
- Discord : https://discord.gg/AZc3by2v9J
