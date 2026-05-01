# headlenss-server

母艦PC上で動くサーバー。tmuxセッション管理APIと、ブラウザからtmuxを操作できるWeb UIを提供する。

将来的にG2(Even Realities G2)アプリからも同じサーバーへ音声入力やテキスト出力をやり取りする予定。

## 必要なもの

- Node.js 20 以上 (v20 / v22 / v24 で動作確認済)
- tmux 3.0 以上
- (任意) Tailscale — 他端末からアクセスする場合
- (任意) ASRバックエンド次第:
  - **whisper-cpp**(ローカル) を使う場合 → ビルドツール:
    - Ubuntu/Debian: `sudo apt install -y build-essential cmake git curl`
    - Fedora: `sudo dnf install -y gcc-c++ cmake git curl make`
    - macOS: `xcode-select --install && brew install cmake`
  - **AmiVoice**(クラウド) を使う場合 → ビルドツール不要。https://acp.amivoice.com/ でAPPKEY取得

> **メモ**: `node-pty` 自体はプリビルドバイナリ同梱フォーク(`@homebridge/node-pty-prebuilt-multiarch`)を使うのでビルド不要。

## インストール & 起動

### A. クラウドASR を使う構成 — ビルドツール不要、最速

#### A-1. Speechmatics(多言語、月480分無料、レイテンシ短い)

```bash
git clone <repo-url> headlenss
cd headlenss/server

npm install
npm run build

ASR_BACKEND=speechmatics \
SPEECHMATICS_API_KEY=your_api_key_here \
SPEECHMATICS_LANG=ja \
npm start
```

- メリット: ビルドツール/setup不要、月480分無料(個人開発期はほぼ無料)、JFKサンプル4秒程度
- デメリット: 従量課金(無料枠超過後は約 $1.35/時間 enhanced)、音声がクラウドへ
- **日本語精度はAmiVoiceより一段下**(AmiVoiceは国産特化なので)

#### A-2. AmiVoice(日本語特化、最高精度)

```bash
ASR_BACKEND=amivoice \
AMIVOICE_APPKEY=your_appkey_here \
npm start
```

- メリット: 日本語精度トップクラス、固有名詞・敬語に強い
- デメリット: 月60分無料、それ以降従量課金(約 ¥0.04/秒)、クレカ登録必須

### B. whisper.cpp (ローカルASR) を使う構成 — オフライン、無料

```bash
git clone <repo-url> headlenss
cd headlenss/server

npm install        # Node依存関係をインストール
npm run setup      # whisper.cpp をビルド + Whisperモデルをダウンロード (初回のみ、~600MBのDLあり)
npm run build      # Web UI をビルド
npm start          # サーバー起動 (デフォルト: 0.0.0.0:3000)
```

ブラウザで `http://localhost:3000/` を開けばtmuxセッション一覧が表示される。

`npm run setup` は冪等なので、再実行しても無駄な作業は走らない。

- メリット: オフライン動作、データ外部送信なし、ランニングコスト無料
- デメリット: モデル格納に~600MB、ビルドツール必要、CPU推論が**GPU/Apple Silicon無し環境では遅い**(large-v3-turboで30秒の音声を約30秒で処理)

## 開発モード

ソース変更でホットリロードしたい場合:

```bash
npm run dev
```

`http://localhost:5173/` をブラウザで開く。Viteのdev server が立ち上がり、`/api/*` と WebSocket は `http://localhost:3000` の Hono サーバーへプロキシされる。

## 環境変数

### サーバー
| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `3000` | リッスンポート |
| `HOST` | `0.0.0.0` | バインドアドレス。`127.0.0.1`にすればローカル限定 |

### ASR(音声認識)バックエンド選択
| 変数 | デフォルト | 説明 |
|---|---|---|
| `ASR_BACKEND` | `whisper-cpp` | `whisper-cpp` / `amivoice` / `speechmatics` |

### whisper-cpp バックエンド (ローカル、無料、`ASR_BACKEND=whisper-cpp`時)
| 変数 | デフォルト | 説明 |
|---|---|---|
| `WHISPER_MODEL` | `ggml-large-v3-turbo-q5_0.bin` | 使用するWhisperモデル。`models/`にダウンロードされる |
| `WHISPER_MODEL_PATH` | (auto) | モデルファイルの絶対パス。指定すれば`WHISPER_MODEL`を上書き |
| `WHISPER_BIN` | (auto) | `whisper-cli`バイナリのパス。指定すれば自前ビルドの`whisper.cpp`が使える |
| `WHISPER_LANG` | `auto` | デフォルト言語コード(`ja`, `en`等)。`auto`で自動判定 |
| `WHISPER_THREADS` | (CPUコア数) | whisper.cppのスレッド数 |
| `WHISPER_CPP_REF` | `master` | `npm run setup`時にcloneする whisper.cpp の git ref |

### AmiVoice バックエンド (クラウド、日本語特化、`ASR_BACKEND=amivoice`時)
| 変数 | デフォルト | 説明 |
|---|---|---|
| `AMIVOICE_APPKEY` | (必須) | AmiVoice API のAPPKEY。https://acp.amivoice.com/ で登録して取得 |
| `AMIVOICE_ENGINE` | `-a-general-input` | エンジンID。日本語音声入力なら `-a-general-input` または `-a2-ja-general` |
| `AMIVOICE_ALLOW_LOGGING` | `false` | `true`にするとログ取り版エンドポイントを使う(料金が安いがAmiVoice側に音声が保存される) |

### Speechmatics バックエンド (クラウド、多言語、`ASR_BACKEND=speechmatics`時)
| 変数 | デフォルト | 説明 |
|---|---|---|
| `SPEECHMATICS_API_KEY` | (必須) | Speechmatics API key。https://portal.speechmatics.com/ で登録して取得 |
| `SPEECHMATICS_LANG` | `ja` | 言語コード(`ja`, `en` 等)。固定値、`auto` 不可 |
| `SPEECHMATICS_OPERATING_POINT` | `enhanced` | `standard`(速い・安い)または `enhanced`(高精度・少し高い) |
| `SPEECHMATICS_MAX_WAIT_MS` | `60000` | ジョブ完了待ちの最大時間(ms) |
| `SPEECHMATICS_POLL_MS` | `500` | ジョブステータスのポーリング間隔(ms) |

## 他の端末から触る (Tailscale)

サーバーは `0.0.0.0` にバインドされているので、同一LANや**Tailscale tailnet 内の他端末**からそのままアクセスできる。

```bash
# このマシンのTailscale IPを確認
tailscale ip -4

# 他端末から:
# http://<このマシンのTailscale IP>:3000/
# http://<このマシンのhostname>:3000/        (MagicDNS)
# http://<hostname>.<tailnet>.ts.net:3000/   (FQDN)
```

### HTTPS化したい場合 (任意)

将来G2スマートグラスのアプリから接続するときは Mixed-Content 回避のためHTTPS推奨。Tailscaleなら`tailscale cert`で無料で証明書が取れる:

```bash
tailscale cert <hostname>.<tailnet>.ts.net
# -> <hostname>.<tailnet>.ts.net.crt と .key が生成される

# 環境変数を渡してサーバー起動 (将来TLS対応する想定)
TLS_CERT_PATH=./<hostname>.<tailnet>.ts.net.crt \
TLS_KEY_PATH=./<hostname>.<tailnet>.ts.net.key \
npm start
```

> **現状の実装**: HTTPS起動オプションはまだ未実装(HTTPのみ)。TailnetはWireGuardで暗号化されているので、ブラウザ→サーバー間の通信は実用上安全。G2連携フェーズでHTTPSを足す。

## API

| Method | Path | 説明 |
|---|---|---|
| `GET`  | `/api/health` | ヘルスチェック |
| `GET`  | `/api/sessions` | tmuxセッション一覧 |
| `POST` | `/api/sessions` | 新規セッション作成 (`{"name":"..."}`) |
| `DELETE` | `/api/sessions/:name` | セッション削除 |
| `POST` | `/api/sessions/:name/input` | セッションにテキストを送り込む(tmux send-keys) |
| `WS`   | `/api/sessions/:name/pty` | tmuxにアタッチするPTYストリーム (xterm.js想定) |
| `GET`  | `/api/asr/status` | 選択中のASRバックエンドが使える状態かを返す。`{"backend":"whisper-cpp","ok":true}` |
| `POST` | `/api/asr` | 音声を文字起こし。`?lang=ja` 等で言語指定可。`{"text":"...","language":"ja","durationMs":1234}`を返す |

### セッション入力(テキスト送信)

`POST /api/sessions/:name/input` でセッション内で動作中のシェル/コマンドにテキストを流し込める。
G2やWeb UIで音声→テキスト変換した結果を、ユーザー確認後にtmuxに送る用途。

リクエスト:
```json
{
  "text": "echo hello",
  "submit": true
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `text` | string (必須) | 送るテキスト。`tmux send-keys -l`(literal mode)で渡されるので、特殊キー名は解釈されず、そのままバイト列として入力される |
| `submit` | boolean (デフォルト false) | `true`なら送信後に Enter を打つ |

例:
```bash
# テキストだけ送る(コマンドラインに表示されるが実行されない)
curl -X POST -H 'content-type: application/json' \
  -d '{"text":"echo hi"}' \
  http://localhost:3000/api/sessions/foo/input

# テキスト + Enter で実行
curl -X POST -H 'content-type: application/json' \
  -d '{"text":"echo hi","submit":true}' \
  http://localhost:3000/api/sessions/foo/input

# Enter だけ(空テキスト + submit)
curl -X POST -H 'content-type: application/json' \
  -d '{"text":"","submit":true}' \
  http://localhost:3000/api/sessions/foo/input
```

存在しないセッションへ送ると 404。

### ASR (音声認識)

`POST /api/asr` の Content-Type:

- `audio/wav` / `audio/x-wav` — WAVファイル(16kHz mono推奨。whisper.cppは内部でリサンプル可、AmiVoiceは16kHz推奨)
- `audio/l16` / `audio/pcm` / `application/octet-stream` — 生PCM 16-bit / 16kHz / mono / S16LE(G2 SDKのフォーマット)

例:
```bash
curl -X POST -H 'content-type: audio/wav' \
  --data-binary @sample.wav \
  http://localhost:3000/api/asr
# {"text":"...", "language":"ja", "durationMs":1234}
```

### ASR バックエンドの比較

| 項目 | whisper-cpp(ローカル) | AmiVoice(クラウド) | Speechmatics(クラウド) |
|---|---|---|---|
| **install手間** | ビルドツール + ~600MB DL | API key取得のみ | API key取得のみ |
| **オフライン動作** | ✓ | ✗ | ✗ |
| **無料枠** | 全部無料 | 月60分 | **月480分** |
| **超過時の料金** | — | 約 ¥158/時間 (nolog汎用) | 約 ¥156/時間 (enhanced) |
| **日本語精度** | ◎(large-v3-turbo) | **◎◎(国産特化、トップ)** | ○ (WER 10-12%帯) |
| **英語精度** | ◎ | ○ | ◎ |
| **多言語対応** | ◎(多言語モデル) | △(日中英韓中心) | ◎(55+言語) |
| **レイテンシ(CPUのみVM)** | 遅い(~30秒/11s音声) | 速い(数秒) | **速い(~4秒/11s音声、実測)** |
| **レイテンシ(GPU/Apple Silicon)** | 速い(数秒) | 速い(数秒) | 速い |
| **プライバシー** | 完全ローカル | 音声が AmiVoice へ | 音声が Speechmatics へ |
| **オンプレ提供** | — | ✓(別契約) | ✓(コンテナで提供) |
| **クレカ登録** | 不要 | 必須(無料枠でも) | 不要(Free枠) |

#### 推奨マトリクス

- **個人開発・PoC・予算重視 → Speechmatics**(月480分無料、レイテンシ短い、英語日本語両対応)
- **日本語精度を極限まで → AmiVoice**(国産、業界特化エンジン)
- **オフライン必須・データ外部送信NG → whisper-cpp**(GPU/Apple Silicon機推奨)

### WebSocket メッセージ仕様

- **クライアント→サーバー**:
  - キーストローク: テキストフレーム (例: `"echo hi\r"`)
  - リサイズ: JSON `{"type":"resize","cols":80,"rows":24}`
- **サーバー→クライアント**: PTY出力をそのまま流す (テキスト/バイナリ両方ありうる)

セッション名は `[a-zA-Z0-9_-]` の最大40文字。WS接続時にセッションが存在しなければ自動作成 (`tmux new-session -A`)。

## フォルダ構成

```
server/
├── src/
│   ├── server/         # Hono APIサーバー、tmux制御、PTY中継、ASR
│   │   ├── index.ts
│   │   ├── tmux.ts
│   │   ├── pty.ts
│   │   └── asr/
│   │       ├── index.ts          # バックエンド選択(ASR_BACKEND env)
│   │       ├── types.ts
│   │       ├── wav.ts            # PCM→WAVヘッダ変換
│   │       ├── whisper-cpp.ts    # whisper.cpp 経由のローカル文字起こし
│   │       ├── amivoice.ts       # AmiVoice API 経由のクラウド文字起こし
│   │       └── speechmatics.ts   # Speechmatics API 経由のクラウド文字起こし
│   └── web/            # React + xterm.js のWeb UI
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── pages/
│       └── styles.css
├── scripts/
│   └── setup-whisper.mjs   # whisper.cpp ビルド & モデルDL (npm run setup)
├── vendor/whisper.cpp/     # cloneされたwhisper.cpp (gitignore)
├── models/                 # Whisperモデルファイル (gitignore)
├── dist/web/               # `npm run build` の出力先
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## 認証について

現在は**認証なし**。Tailnet ACLに任せる前提。`HOST=127.0.0.1` で起動すればローカル限定にはできる。

将来 G2 アプリから外部公開する際は適切な認証を実装する想定。

## 制約・既知の挙動

- **セッション共有**: 同じtmuxセッションに複数のWS接続が来た場合、tmuxの仕様で全クライアントが同じビューを共有する。違うビューが欲しい場合は別セッションを作る。
- **node-pty フォーク**: 上流の `node-pty` はNode 24用のプリビルドが未対応のため、プリビルド同梱フォークを使用している。将来上流が対応したら戻す予定。
