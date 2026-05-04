# _drafts/

提供方法を後で詰めるために **リポジトリ内にソースとしてだけ残しておく** 場所。
plugin (`plugin/`) 配下ではないので Claude Code の plugin loader からは認識されない。

ここに置かれたファイルは:

- 自動でロードされない (skill / command / hook 等として読まれない)
- 動作させるときは、然るべき場所に手で copy / move する
- 「いま develop 環境で作業している Claude Code が誤って発動するのを避けたい」もの置き場

## 中身

- `skills/spawn-claude/SKILL.md` — headlenss server 経由で別 tmux + Claude Code を spawn する skill のドラフト。提供方法 (plugin 同梱 / MCP 化 / その他) を決めるまで draft 扱い。
