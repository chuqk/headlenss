import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { extractImagesFromClipboard, filterImageFiles, uploadImage } from '../uploads.ts';

type Mode = 'tmux' | 'chat';
type ChatMessage = { role: 'user' | 'assistant'; text: string; ts: number; synthetic?: boolean };
type SessionStatus = 'idle' | 'busy' | 'waiting-permission' | 'waiting-question';

type AskQuestionOption = { label: string; description?: string };
type AskQuestion = {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options?: AskQuestionOption[];
};
type Pending = {
  id: string;
  kind: 'permission' | 'question';
  toolName: string;
  toolInput: unknown;
  questions?: AskQuestion[];
  createdAt: number;
};

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
  // Claude Code の動作状態。busy / waiting-* の時に「考え中」インジケータを表示。
  const [status, setStatus] = useState<SessionStatus>('idle');
  // pending interaction: AskUserQuestion / 許可リクエストの待ち状態
  // (chat の楽観的更新用 `pending` とは別物。InterAction の意味で `pendingInter`)
  const [pendingInter, setPendingInter] = useState<Pending | null>(null);
  // 質問への回答種別 (predefined / type-something / chat-about-this)
  const [qKind, setQKind] = useState<Record<number, 'predefined' | 'type-something' | 'chat-about-this'>>({});
  // predefined 用: 選んだ option の label
  const [qSelections, setQSelections] = useState<Record<number, string>>({});
  // predefined 用: 選んだ option に添える補足メモ(任意)
  const [qNotes, setQNotes] = useState<Record<number, string>>({});
  // type-something 用: 自由記述テキスト
  const [qFreeText, setQFreeText] = useState<Record<number, string>>({});
  // 現在表示している質問の index。最後まで進むと totalQ になり、確認&送信画面を出す
  const [currentQIdx, setCurrentQIdx] = useState(0);
  // 許可リクエスト用のメッセージ
  const [permMessage, setPermMessage] = useState('');
  const [respondingPending, setRespondingPending] = useState(false);
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
          const json = (await res.json()) as {
            chat: ChatMessage[];
            status?: SessionStatus;
            pending?: Pending | null;
          };
          if (!disposed) {
            // 合成メッセージ (status 表示用に server 側で動的注入したもの) は
            // PC chat では dot インジケータが既にあるので除外。G2 はこれを表示する。
            const next = (json.chat ?? []).filter((m) => !m.synthetic);
            setServerChat(next);
            if (json.status) setStatus(json.status);
            // pending が変わった(or null になった)ら入力中の選択肢/メモを破棄して
            // 別の質問に持ち越さないようにする
            setPendingInter((prev) => {
              const incoming = json.pending ?? null;
              if (prev?.id !== incoming?.id) {
                setQSelections({});
                setQNotes({});
                setQFreeText({});
                setQKind({});
                setPermMessage('');
                setCurrentQIdx(0);
              }
              return incoming;
            });
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

  // 状態が変化(idle → busy 等)した時にも末尾追従。ユーザが下にいたなら、
  // 新しく現れた「考え中」インジケータが見える位置に揃える。
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      requestAnimationFrame(() => {
        const el = scrollerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [status]);

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

  // pending への応答送信
  const respondToPending = useCallback(async (
    body: { kind: 'permission'; decision: 'allow' | 'deny'; message?: string }
       | { kind: 'question'; answers: Array<{ question: string; option: string; notes?: string }> },
  ) => {
    if (!pendingInter || respondingPending) return;
    setRespondingPending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/claude/sessions/${encodeURIComponent(sessionName)}/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      // 楽観的にローカル pending を消す。次の poll でサーバ側からも消える(が一足早く UI 反映)。
      setPendingInter(null);
      setQSelections({});
      setQNotes({});
      setPermMessage('');
    } catch (e) {
      setError(`応答送信失敗: ${(e as Error).message}`);
    } finally {
      setRespondingPending(false);
    }
  }, [pendingInter, respondingPending, sessionName]);

  const submitQuestion = useCallback(() => {
    if (!pendingInter?.questions) return;
    const answers = pendingInter.questions.map((q, i) => {
      const kind = qKind[i] ?? 'predefined';
      if (kind === 'chat-about-this') {
        return { question: q.question, answerKind: 'chat-about-this' as const };
      }
      if (kind === 'type-something') {
        return {
          question: q.question,
          answerKind: 'type-something' as const,
          text: qFreeText[i] ?? '',
        };
      }
      return {
        question: q.question,
        answerKind: 'predefined' as const,
        option: qSelections[i] ?? '',
        notes: (qNotes[i] ?? '').trim() || undefined,
      };
    });
    // 検証: predefined は option 必須、type-something は text 必須、
    // chat-about-this は何も必要なし。chat-about-this が含まれている場合は他の質問は無視。
    if (answers.some((a) => a.answerKind === 'chat-about-this')) {
      void respondToPending({ kind: 'question', answers });
      return;
    }
    if (answers.some((a) =>
      (a.answerKind === 'predefined' && !a.option) ||
      (a.answerKind === 'type-something' && !(a.text ?? '').trim()))
    ) {
      setError('未回答の質問があります');
      return;
    }
    void respondToPending({ kind: 'question', answers });
  }, [pendingInter, qSelections, qNotes, qFreeText, qKind, respondToPending]);

  const submitPermission = useCallback((decision: 'allow' | 'deny') => {
    void respondToPending({
      kind: 'permission',
      decision,
      message: permMessage.trim() || undefined,
    });
  }, [permMessage, respondToPending]);

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
        {status !== 'idle' && (
          <div className={`chat-status chat-status-${status}`}>
            <span className="chat-status-dot" aria-hidden="true" />
            <span className="chat-status-text">
              {status === 'busy' && 'Claude が考えています'}
              {status === 'waiting-permission' && 'Claude が許可を待っています'}
              {status === 'waiting-question' && 'Claude が質問を待っています'}
            </span>
          </div>
        )}

        {pendingInter?.kind === 'question' && pendingInter.questions && pendingInter.questions.length > 0 && (() => {
          const totalQ = pendingInter.questions.length;
          const idx = Math.max(0, Math.min(currentQIdx, totalQ));
          // 各質問が回答済みか
          const isAnswered = (i: number): boolean => {
            const k = qKind[i] ?? 'predefined';
            if (k === 'chat-about-this') return true;
            if (k === 'type-something') return (qFreeText[i] ?? '').trim().length > 0;
            return typeof qSelections[i] === 'string' && (qSelections[i] as string).length > 0;
          };
          const allAnswered = pendingInter.questions.every((_q, i) => isAnswered(i));
          const hasChatAbout = pendingInter.questions.some((_q, i) => qKind[i] === 'chat-about-this');

          // 確認&送信画面
          if (idx === totalQ) {
            return (
              <div className="chat-pending">
                <div className="chat-pending-title">
                  {hasChatAbout ? '質問のキャンセル確認' : '回答内容の確認'}
                </div>
                {pendingInter.questions.map((q, qi) => {
                  const k = qKind[qi] ?? 'predefined';
                  return (
                    <div key={qi} className="chat-pending-summary">
                      <div className="chat-pending-summary-q">
                        Q{qi + 1}. {q.question}
                      </div>
                      <div className="chat-pending-summary-a">
                        {k === 'chat-about-this' && '→ (Chat about this を選択 → 質問キャンセル)'}
                        {k === 'type-something' && (
                          <>→ <span style={{ fontStyle: 'italic' }}>(自由記述)</span> {qFreeText[qi] ?? ''}</>
                        )}
                        {k === 'predefined' && (
                          qSelections[qi] ? (
                            <>
                              → {qSelections[qi]}
                              {qNotes[qi]?.trim() && (
                                <span className="chat-pending-summary-note"> /補足: {qNotes[qi]}</span>
                              )}
                            </>
                          ) : <em>(未回答)</em>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div className="chat-pending-actions">
                  <button
                    type="button"
                    className="chat-pending-back"
                    onClick={() => setCurrentQIdx(totalQ - 1)}
                    disabled={respondingPending}
                  >
                    ← 戻る
                  </button>
                  <button
                    type="button"
                    className="chat-pending-submit"
                    onClick={submitQuestion}
                    disabled={respondingPending || (!allAnswered && !hasChatAbout)}
                  >
                    {respondingPending
                      ? '送信中…'
                      : hasChatAbout
                      ? 'キャンセル送信'
                      : allAnswered
                      ? '送信'
                      : '未回答あり'}
                  </button>
                </div>
              </div>
            );
          }

          const q = pendingInter.questions[idx];
          const kind = qKind[idx] ?? 'predefined';
          const selected = qSelections[idx];
          return (
            <div className="chat-pending">
              <div className="chat-pending-title">
                Claude からの質問 ({idx + 1} / {totalQ})
              </div>
              <div className="chat-pending-q">
                {q.header && <div className="chat-pending-header">{q.header}</div>}
                <div className="chat-pending-qtext">{q.question}</div>

                {/* predefined 選択肢 (kind が type-something 中はグレーアウト) */}
                <div className="chat-pending-options">
                  {(q.options ?? []).map((opt, oi) => {
                    const active = kind === 'predefined' && selected === opt.label;
                    return (
                      <button
                        key={oi}
                        type="button"
                        className={`chat-pending-option${active ? ' active' : ''}`}
                        onClick={() => {
                          setQKind((k) => ({ ...k, [idx]: 'predefined' }));
                          setQSelections((s) => ({ ...s, [idx]: opt.label }));
                          // 補足メモに内容があれば「次へ」を押してもらうため自動進行しない。
                          // 空なら従来通り自動で次へ進む。
                          if (!(qNotes[idx] ?? '').trim()) {
                            setCurrentQIdx(idx + 1);
                          }
                        }}
                        disabled={respondingPending || kind === 'type-something'}
                      >
                        <div className="chat-pending-option-label">{opt.label}</div>
                        {opt.description && (
                          <div className="chat-pending-option-desc">{opt.description}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
                {/* 補足メモ (predefined option を選んだときに添えて送れる) */}
                {kind !== 'type-something' && (
                  <textarea
                    className="chat-pending-notes"
                    placeholder="補足メモ (任意)。選んだ選択肢と一緒に Claude に届きます。"
                    rows={1}
                    value={qNotes[idx] ?? ''}
                    onChange={(e) => setQNotes((n) => ({ ...n, [idx]: e.target.value }))}
                    disabled={respondingPending}
                  />
                )}

                {/* Type something */}
                {kind !== 'type-something' ? (
                  <button
                    type="button"
                    className="chat-pending-extra"
                    onClick={() => setQKind((k) => ({ ...k, [idx]: 'type-something' }))}
                    disabled={respondingPending}
                  >
                    ✎ Type something(自由記述で答える)
                  </button>
                ) : (
                  <div className="chat-pending-typesomething">
                    <div className="chat-pending-typesomething-label">自由記述</div>
                    <textarea
                      className="chat-pending-notes"
                      placeholder="自由記述してください"
                      rows={2}
                      value={qFreeText[idx] ?? ''}
                      onChange={(e) => setQFreeText((n) => ({ ...n, [idx]: e.target.value }))}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="chat-pending-cancel-type"
                      onClick={() => {
                        setQKind((k) => { const { [idx]: _, ...rest } = k; return rest; });
                        setQFreeText((n) => { const { [idx]: _, ...rest } = n; return rest; });
                      }}
                    >
                      自由記述をやめて選択肢に戻る
                    </button>
                  </div>
                )}

                {/* Chat about this */}
                <button
                  type="button"
                  className="chat-pending-chat-about"
                  onClick={() => {
                    if (window.confirm('Chat about this を選ぶと、AskUserQuestion 全体がキャンセルされて自由対話に切り替わります。続けますか?')) {
                      setQKind((k) => ({ ...k, [idx]: 'chat-about-this' }));
                      setCurrentQIdx(totalQ); // 直接確認画面へ
                    }
                  }}
                  disabled={respondingPending}
                >
                  💬 Chat about this(質問をキャンセルして自由対話)
                </button>
              </div>
              <div className="chat-pending-actions">
                <button
                  type="button"
                  className="chat-pending-back"
                  onClick={() => setCurrentQIdx(idx - 1)}
                  disabled={idx === 0 || respondingPending}
                >
                  ← 戻る
                </button>
                {isAnswered(idx) && (
                  <button
                    type="button"
                    className="chat-pending-next"
                    onClick={() => setCurrentQIdx(idx + 1)}
                    disabled={respondingPending}
                  >
                    {idx + 1 === totalQ ? '確認へ →' : '次へ →'}
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        {pendingInter?.kind === 'permission' && (
          <div className="chat-pending">
            <div className="chat-pending-title">Claude からの許可リクエスト</div>
            <div className="chat-pending-tool">tool: <code>{pendingInter.toolName}</code></div>
            <pre className="chat-pending-toolinput">
              {(() => {
                try { return JSON.stringify(pendingInter.toolInput, null, 2); }
                catch { return String(pendingInter.toolInput); }
              })()}
            </pre>
            <textarea
              className="chat-pending-notes"
              placeholder="メッセージ (任意)"
              rows={1}
              value={permMessage}
              onChange={(e) => setPermMessage(e.target.value)}
            />
            <div className="chat-pending-actions">
              <button
                type="button"
                className="chat-pending-submit allow"
                onClick={() => submitPermission('allow')}
                disabled={respondingPending}
              >
                許可
              </button>
              <button
                type="button"
                className="chat-pending-submit deny"
                onClick={() => submitPermission('deny')}
                disabled={respondingPending}
              >
                拒否
              </button>
            </div>
          </div>
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
