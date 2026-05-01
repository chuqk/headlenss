# headlenss

Even Realities G2 スマートグラスから、母艦PC上で動くClaude Codeへ音声で指示を出し、
出力をレンズに表示するためのプロジェクト。

Tailscale越しに、PCやスマホのブラウザからもtmux/Claude Codeを操作できるWeb UIを提供する。

## このリポジトリの状態

開発中。現在は `server/` のみ実装が始まっている。

## 構成

```
headlenss/
├── server/   # 母艦PC上で動くサーバー (tmux管理API + Web UI)
└── even/     # Even G2用アプリ (未着手)
```

詳細な設計方針は [plan.md](./plan.md) を参照。

## クイックスタート (server)

```bash
cd server
npm install
npm run build
npm start
```

詳細は [server/README.md](./server/README.md)。

## ライセンス

未定 (将来OSS公開予定)。
