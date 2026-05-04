---
name: spawn-claude
description: ユーザが「新しい Claude を立てて」「別の tmux で Claude を起動して」のように、別の tmux + Claude Code セッションを spawn する要求をしたときに使う。headlenss server の POST /api/sessions を curl で呼んで新規 tmux と Claude Code を起動する。tmux セッション名と作業ディレクトリ (省略可) を引数に取る。
---

# spawn-claude

別の tmux 上で新しい Claude Code を起動する。headlenss server (`${HEADLENSS_SERVER_URL}`、未設定なら `http://localhost:3000`) の `POST /api/sessions` を curl で呼ぶ。

## 入力

- `<name>` (必須): tmux セッション名。server 側の validation は `[a-zA-Z0-9_-]{1,40}` (= 英数字とハイフン/アンダースコアのみ、最大 40 文字)
- `<cwd>` (省略可): 作業ディレクトリ。`~/...` / 相対パス / 絶対パスを受け付ける (server 側でホーム基準に解決される)。省略可だが、省略するとユーザの意図と外れた場所で起動する可能性があるので、原則として確定させてから呼ぶ

## 手順

1. ユーザの要求から `<name>` を確定する。曖昧なら 1 度確認する。同名の session が既にあると server がエラーを返すので、被らない名前にする (必要なら事前に `GET /api/claude/sessions` で確認)
2. `<cwd>` を確定する:
   - 「今と同じ場所で」 → 親 tmux の cwd を流用
   - 「新しい場所」 → `~/temp/spawn-<name>-<timestamp>` のような捨て場を提案、もしくはユーザに確定させる
3. server URL を解決:
   ```bash
   URL="${HEADLENSS_SERVER_URL:-http://localhost:3000}"
   ```
4. POST で起動要求:
   ```bash
   curl -sS -X POST "$URL/api/sessions" \
     -H 'content-type: application/json' \
     -d '{"name":"<name>","cwd":"<cwd>","startClaude":true}'
   ```
5. 応答 JSON を確認:
   - `{"ok":true}` → 起動要求は受理。実際の Claude Code 起動には数秒かかる
   - `{"error":"..."}` → 内容をユーザに伝える (`invalid session name` / `session already exists` 等)

## 立てた直後に初期 prompt を送りたい場合

ユーザが「立てて、これをやらせて」のような複合要求をしたら、立てた直後に input API で初期 prompt を流す:

```bash
curl -sS -X POST "$URL/api/sessions/<name>/input" \
  -H 'content-type: application/json' \
  -d '{"text":"<prompt>","submit":true}'
```

ただし Claude Code の起動完了前に流すと取りこぼす可能性がある。次のいずれかで起動完了を待ってから流す:
- `GET /api/claude/sessions` を polling して `tmuxSessionName` がリストに出るまで待つ
- 数秒 (3-5 秒程度) sleep する

## 注意

- **同名衝突**: 既に同じ name の tmux session があると server がエラーを返す。事前に `GET /api/claude/sessions` で確認するか、ユーザに別名を提案する
- **乱発防止**: ユーザの明示的な要求 1 回につき 1 回だけ実行する。確認なしに連続 spawn しない
- **登録の自動性**: 立てた Claude Code は plugin hooks 経由で headlenss server の registry に自動登録される。G2 lens / WebView の Claude セッション一覧に出てきたら起動完了と判断できる
- **権限境界**: spawn された Claude Code は親と独立した tmux pane で動く。secrets や conversation context は引き継がれない
