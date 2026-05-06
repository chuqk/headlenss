import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { extractImagesFromClipboard, filterImageFiles, uploadImage } from '../uploads.ts';

type Mode = 'tmux' | 'chat';
type ChatMessage = { role: 'user' | 'assistant'; text: string; ts: number };

/** 表示用前処理: `@/tmp/headlenss-uploads/<file>` を見つけたら markdown image
 *  記法 `![](/api/uploads/<file>)` に置き換え、チャットバブル内でインライン
 *  画像として表示できるようにする。
 *  Claude Code が読む元の文字列(transcript / hook 由来)は path のままなので、
 *  画像参照の意味は壊さない。 */
function inlineUploadedImages(text: string): string {
  return text.replace(
    /@(\/tmp\/headlenss-uploads\/([a-zA-Z0-9._-]+))/g,
    (_match, _full: string, filename: string) => `![](/api/uploads/${filename})`,
  );
}

export function ChatView({
  sessionName,
  onBack,
  onSwitchMode,
}: {
  sessionName: string;
  onBack: () => void;
  onSwitchMode: (m: Mode) => void;
}) {
  // サーバから返ってくる確定 chat
  const [serverChat, setServerChat] = useState<ChatMessage[]>([]);
  // 送信直後の楽観的表示メッセージ。サーバ側 (transcript / hook) に同じ user メッセージが
  // 出てきたら自動的にここから取り除く。
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const lastLenRef = useRef(0);
  const userScrolledUpRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // 表示は server + pending を順に並べる(pending は常に末尾、ts 順)
  const displayChat = useMemo(() => {
    return [...serverChat, ...pending];
  }, [serverChat, pending]);

  // 末尾近くに居れば新規メッセージで自動末尾追従。離れていれば追従しない。
  const isNearBottom = () => {
    const el = scrollerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  };

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetch(`/api/claude/sessions/${encodeURIComponent(sessionName)}/chat`);
        if (!res.ok) {
          // 404 = まだ chat 履歴なし。エラー表示はしない。
          if (res.status !== 404) throw new Error(`HTTP ${res.status}`);
          if (!disposed) setServerChat([]);
        } else {
          const json = (await res.json()) as { chat: ChatMessage[] };
          if (!disposed) {
            const next = json.chat ?? [];
            setServerChat(next);
            // pending のうち、サーバ側に取り込まれたものを除去 (role+text 一致で判定)。
            // 同一文言を 2 回送るケースに備えて 1 件だけ消す。
            setPending((prev) => {
              if (prev.length === 0) return prev;
              const remaining: ChatMessage[] = [];
              const consumed = new Set<number>();
              for (const pm of prev) {
                let matchedIdx = -1;
                for (let i = 0; i < next.length; i++) {
                  if (consumed.has(i)) continue;
                  const s = next[i];
                  if (s.role === pm.role && s.text === pm.text) {
                    matchedIdx = i;
                    break;
                  }
                }
                if (matchedIdx === -1) remaining.push(pm);
                else consumed.add(matchedIdx);
              }
              return remaining;
            });
          }
        }
        if (!disposed) setError(null);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
      if (!disposed) timer = setTimeout(tick, 1500);
    };
    tick();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionName]);

  // displayChat が伸びたら自動末尾追従(履歴遡り中はしない)
  useEffect(() => {
    if (displayChat.length > lastLenRef.current && !userScrolledUpRef.current) {
      requestAnimationFrame(() => {
        const el = scrollerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
    lastLenRef.current = displayChat.length;
  }, [displayChat.length]);

  const onScroll = () => {
    userScrolledUpRef.current = !isNearBottom();
  };

  const send = useCallback(async () => {
    const text = input;
    if (!text.trim() || sending) return;

    // 楽観的 UI 更新: 送信直後にチャット表示へ即時反映
    const optimistic: ChatMessage = { role: 'user', text, ts: Date.now() };
    setPending((p) => [...p, optimistic]);
    setInput('');
    userScrolledUpRef.current = false;

    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, submit: true }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      // 送信失敗時は楽観的メッセージを取り除いて入力欄に戻す
      setPending((p) => p.filter((m) => m !== optimistic));
      setInput(text);
      setError((e as Error).message);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [input, sending, sessionName]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  // 画像をサーバにアップロード → 取得した path を `@path ` 形式でカーソル位置に挿入。
  // Claude Code は `@/path/to/file.png` で画像を読み込める(v2.1.121+ で自動圧縮)。
  const insertAtCursor = useCallback((text: string) => {
    const ta = inputRef.current;
    setInput((prev) => {
      if (!ta) return prev + text;
      const start = ta.selectionStart ?? prev.length;
      const end = ta.selectionEnd ?? prev.length;
      const next = prev.slice(0, start) + text + prev.slice(end);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          const pos = start + text.length;
          inputRef.current.setSelectionRange(pos, pos);
          inputRef.current.focus();
        }
      });
      return next;
    });
  }, []);

  const handleImageFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of files) {
        try {
          const r = await uploadImage(f);
          insertAtCursor(`@${r.path} `);
        } catch (e) {
          setError(`アップロード失敗 (${f.name}): ${(e as Error).message}`);
        }
      }
    } finally {
      setUploading(false);
    }
  }, [insertAtCursor]);

  const onPaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = extractImagesFromClipboard(e.clipboardData.items);
    if (images.length > 0) {
      e.preventDefault();
      await handleImageFiles(images);
    }
  }, [handleImageFiles]);

  // textarea の高さを行数に合わせて伸ばす。max-height は CSS 側で打ち、
  // 越えた分は overflow-y: auto でスクロール。input が空になったら 1 行に戻す。
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [input]);

  return (
    <div className="page-session chat-view">
      <header className="session-header">
        <button onClick={onBack} aria-label="back">← back</button>
        <span className="session-title">{sessionName}</span>
        <div className="mode-toggle" role="group" aria-label="表示モード">
          <button
            type="button"
            className="mode-toggle-btn"
            onClick={() => onSwitchMode('tmux')}
            aria-pressed={false}
          >
            tmux
          </button>
          <button
            type="button"
            className="mode-toggle-btn active"
            aria-pressed={true}
          >
            chat
          </button>
        </div>
      </header>
      <div ref={scrollerRef} onScroll={onScroll} className="chat-scroller">
        {displayChat.length === 0 ? (
          <div className="chat-empty">まだ会話がありません。</div>
        ) : (
          displayChat.map((m, i) => {
            const isPending = i >= serverChat.length;
            return (
              <div
                key={i}
                className={`chat-msg chat-msg-${m.role}${isPending ? ' chat-msg-pending' : ''}`}
              >
                <div className="chat-msg-role">{m.role === 'user' ? 'YOU' : 'Claude'}</div>
                <div className="chat-msg-bubble markdown-body">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkBreaks]}
                    components={{
                      a: ({ children, href, ...rest }) => (
                        <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                          {children}
                        </a>
                      ),
                      // loose list で react-markdown が <li><p>...</p></li> を出すと
                      // 空白テキストノードが li 内に残って anonymous block boxes が
                      // 余分な高さを生む。<p> 単独子の場合は <p> を剥がして tight list と
                      // 同じ DOM 構造に揃える。
                      li: ({ children, ...rest }) => {
                        const arr = React.Children.toArray(children);
                        const meaningful = arr.filter((c) =>
                          typeof c === 'string' ? c.trim().length > 0 : true,
                        );
                        if (
                          meaningful.length === 1 &&
                          React.isValidElement(meaningful[0]) &&
                          (meaningful[0] as React.ReactElement).type === 'p'
                        ) {
                          const p = meaningful[0] as React.ReactElement<{ children?: React.ReactNode }>;
                          return <li {...rest}>{p.props.children}</li>;
                        }
                        return <li {...rest}>{children}</li>;
                      },
                    }}
                  >
                    {inlineUploadedImages(m.text)}
                  </ReactMarkdown>
                </div>
              </div>
            );
          })
        )}
      </div>
      {error && <div className="chat-error">送信エラー: {error}</div>}
      <form
        className="chat-input"
        onSubmit={(e) => { e.preventDefault(); void send(); }}
      >
        <button
          type="button"
          className="chat-attach"
          onClick={() => fileInputRef.current?.click()}
          aria-label="画像を添付"
          title="画像を添付 (ペーストもOK)"
          disabled={uploading}
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) {
              void handleImageFiles(filterImageFiles(e.target.files));
            }
            e.target.value = '';
          }}
        />
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={uploading ? 'アップロード中…' : 'メッセージを入力 (Enterで送信、Shift+Enterで改行、画像はペースト可)'}
          rows={1}
          disabled={sending}
        />
        <button type="submit" disabled={sending || !input.trim()}>
          {sending ? '...' : '送信'}
        </button>
      </form>
    </div>
  );
}
