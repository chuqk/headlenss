# headlenss

Even Realities G2 スマートグラスから Claude Code を音声操作するための環境セットアップ。

## 何を作ろうとしているか

takashicompany/headlenss を自分の G2 + Mac 環境で動かす。
サーバー (Node.js + tmux)、G2 アプリ (Even WebView)、Claude Code プラグインの
3層構成で、メガネのマイクから音声でプロンプトを投げ、レンズに結果を表示する。

## 構想に至った背景

G2 本体で Claude Code を音声操作したい。キーボードから離れた状態でも
開発を進められる体験を作る。

## 調査結果とセットアップ状況

- Node.js v22.18.0, tmux 3.6a — 要件充足
- Tailscale 接続済み (gargantua: 100.112.122.97)
- GitHub フォーク: chuqk/headlenss (upstream: takashicompany/headlenss)
- server/, even/ ともに npm install 済み
- ghost (bashboard) でデーモン管理設定済み

## 決定事項

- **ポート**: 3100 (orchestrator_extension が 3000 を使用中のため変更)
- **ASR**: AmiVoice (G2 マイク経由の音声入力のみ、月60分無料枠で十分)
- **リモート構成**: origin=chuqk/headlenss, upstream=takashicompany/headlenss

## 未決事項

- AmiVoice AppKey の取得・1Password 登録・.env 設定
- Claude Code プラグインの導入 (/plugin marketplace add)
- G2 アプリのビルド・インストール (even/)
- HOST=0.0.0.0 + ALLOWED_ORIGINS 設定 (Tailscale 経由アクセス用)

## 次にやること

1. AmiVoice アカウント作成 → AppKey 取得 → op に保存 → .env に注入
2. サーバーを Tailscale 経由でアクセス可能にする (HOST/ALLOWED_ORIGINS)
3. G2 アプリをビルドしてスマホにインストール
4. Claude Code プラグイン導入
