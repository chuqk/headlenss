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
   ↕ HTTP/WS (tailscale経由、HTTPS)
母艦PC(server/ の中身、Hono + tmux + whisper.cpp + Claude Code)
   ↕ HTTP/WS
ブラウザ(スマホ/PC、Web画面)
```

- G2本体ではJSは動かない。表示・入力・音声キャプチャの末端デバイス。
- G2アプリは「ペアリングしたスマホ上のWebView」で動作する(Even Hub SDKの制約)。
- 母艦PCはサーバー、tmuxホスト、Claude Code実行環境、whisper.cppサーバーを兼ねる。
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
- 母艦PC ↔ G2アプリ(スマホ) : HTTP API + WebSocket
  - 音声 : G2マイクからのPCMチャンクをWSでストリーミング送信、サーバーで whisper.cpp に流して文字起こし
  - テキスト出力 : サーバーから WS でテキストを push、G2アプリは `textContainerUpgrade` でレンズに反映
  - WSが whitelist や CORS で問題が出る場合は SSE / fetch ストリーミングに切り替え検討

# 検証が必要な未確定事項

- WebView の `network` permission whitelist が `wss://` を許容するか
- tailscale ホスト(`<host>.<tailnet>.ts.net`)が whitelist で通るか
- iOS / Android のローカルネットワーク許可ダイアログの挙動
- 長文出力の page flip UX(~400-500文字ごとにユーザーがスワイプで進める想定)

# 開発の進め方

1. server/ から先に着手。tmuxセッション管理API + Web画面 + xterm.js中継。
2. whisper.cppセットアップと `POST /api/asr`(or WS版)エンドポイント。
3. even/ を asrテンプレートから起動。シミュレーターで音声→母艦PC→文字起こし→G2表示の往復を確立。
4. 実機G2でマイク精度・表示・タッチ操作を検証。
5. マスターエージェント機能を組み込み(後追い)。

# 参考リソース

- 公式docs : https://hub.evenrealities.com/docs
- SDK : https://www.npmjs.com/package/@evenrealities/even_hub_sdk
- 公式テンプレート : https://github.com/even-realities/evenhub-templates
- コミュニティRコンポーネント集 : https://github.com/fabioglimb/even-toolkit
- Discord : https://discord.gg/AZc3by2v9J
