# headlenss-server

母艦PC上で動くサーバー。tmuxセッション管理APIと、ブラウザからtmuxを操作できるWeb UIを提供する。

将来的にG2(Even Realities G2)アプリからも同じサーバーへ音声入力やテキスト出力をやり取りする予定。

## 必要なもの

- Node.js 20 以上 (v20 / v22 / v24 で動作確認済)
- tmux 3.0 以上
- (任意) Tailscale — 他端末からアクセスする場合

> **メモ**: 一般的に `node-pty` はビルドツール (`build-essential` など) が必要だが、headlenssはプリビルドバイナリ同梱の `@homebridge/node-pty-prebuilt-multiarch` を使用するため**追加のビルドツール不要**。

## インストール & 起動

```bash
git clone <repo-url> headlenss
cd headlenss/server

npm install
npm run build      # Web UI をビルド
npm start          # サーバー起動 (デフォルト: 0.0.0.0:3000)
```

ブラウザで `http://localhost:3000/` を開けばtmuxセッション一覧が表示される。

## 開発モード

ソース変更でホットリロードしたい場合:

```bash
npm run dev
```

`http://localhost:5173/` をブラウザで開く。Viteのdev server が立ち上がり、`/api/*` と WebSocket は `http://localhost:3000` の Hono サーバーへプロキシされる。

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `3000` | リッスンポート |
| `HOST` | `0.0.0.0` | バインドアドレス。`127.0.0.1`にすればローカル限定 |

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
| `WS`   | `/api/sessions/:name/pty` | tmuxにアタッチするPTYストリーム (xterm.js想定) |

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
│   ├── server/         # Hono APIサーバー、tmux制御、PTY中継
│   │   ├── index.ts
│   │   ├── tmux.ts
│   │   └── pty.ts
│   └── web/            # React + xterm.js のWeb UI
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── pages/
│       └── styles.css
├── dist/web/           # `npm run build` の出力先
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
