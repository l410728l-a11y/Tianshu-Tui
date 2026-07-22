import { useEffect, useReducer, useRef, useState, useCallback, type DragEvent } from 'react'
import {
  onHostMessage,
  send,
  type DomainEntry,
  type HostMsg,
  type ModelEntry,
  type SessionEvent,
  type SessionRecord,
} from './bridge.js'
import { initialChatState, reduceEvent, type ChatState, type ChatItem, type QuestionSpec } from './model.js'

type SidecarState = 'starting' | 'ready' | 'dead'

function chatReducer(state: ChatState, action: { type: 'event'; ev: SessionEvent } | { type: 'reset' }): ChatState {
  if (action.type === 'reset') return initialChatState
  return reduceEvent(state, action.ev)
}

let fileReqSeq = 0

export function App() {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [activeId, setActiveId] = useState<string | undefined>()
  const [sidecar, setSidecar] = useState<SidecarState>('starting')
  const [sidecarDetail, setSidecarDetail] = useState('')
  const [live, setLive] = useState(false)
  const [errorBanner, setErrorBanner] = useState('')
  const [models, setModels] = useState<ModelEntry[]>([])
  const [domains, setDomains] = useState<DomainEntry[]>([])
  const [fileHits, setFileHits] = useState<string[]>([])
  const fileReqRef = useRef(0)
  const [chat, dispatch] = useReducer(chatReducer, initialChatState)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const off = onHostMessage((msg: HostMsg) => {
      switch (msg.type) {
        case 'sessions':
          setSessions(msg.sessions)
          break
        case 'sessionCreated':
          setSessions((prev) => [msg.session, ...prev])
          setActiveId(msg.session.id)
          send({ type: 'listPickers', sessionId: msg.session.id })
          break
        case 'sessionAttached':
          setActiveId(msg.sessionId)
          dispatch({ type: 'reset' })
          send({ type: 'listPickers', sessionId: msg.sessionId })
          break
        case 'event':
          dispatch({ type: 'event', ev: msg.event })
          break
        case 'streamState':
          setLive(msg.live)
          break
        case 'sidecarState':
          setSidecar(msg.state)
          setSidecarDetail(msg.detail ?? '')
          break
        case 'pickers':
          setModels(msg.models)
          setDomains(msg.domains)
          break
        case 'files':
          if (msg.reqId === fileReqRef.current) setFileHits(msg.files)
          break
        case 'error':
          setErrorBanner(msg.message)
          break
      }
    })
    send({ type: 'ready' })
    return off
  }, [])

  // 新内容到达时贴底滚动（用户上滚查看历史时不打扰）。
  useEffect(() => {
    const el = bottomRef.current
    if (!el) return
    const scroller = el.parentElement
    if (!scroller) return
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
    if (nearBottom) el.scrollIntoView()
  }, [chat.items])

  const running = chat.status === 'running'

  const submit = useCallback(
    (text: string) => {
      setErrorBanner('')
      if (!activeId) {
        send({ type: 'createSession', prompt: text })
        return
      }
      send({ type: running ? 'steer' : 'prompt', sessionId: activeId, text })
    },
    [activeId, running],
  )

  const queryFiles = useCallback(
    (q: string) => {
      if (!activeId) return
      const reqId = ++fileReqSeq
      fileReqRef.current = reqId
      send({ type: 'queryFiles', sessionId: activeId, q, reqId })
    },
    [activeId],
  )

  return (
    <div className="app">
      <Header
        sessions={sessions}
        activeId={activeId}
        live={live}
        sidecar={sidecar}
        onSelect={(id) => send({ type: 'selectSession', sessionId: id })}
        onNew={() => {
          setActiveId(undefined)
          dispatch({ type: 'reset' })
        }}
      />
      {activeId && (
        <Toolbar
          sessionId={activeId}
          models={models}
          domains={domains}
          planMode={chat.planMode}
          running={running}
        />
      )}
      {sidecar === 'dead' && (
        <div className="banner error">内核不可用：{sidecarDetail || '进程已退出'}（命令面板 → 天枢: 重启内核）</div>
      )}
      {errorBanner && <div className="banner error">{errorBanner}</div>}
      {chat.todos.length > 0 && <TodoPanel todos={chat.todos} />}
      <div className="messages">
        {chat.items.length === 0 && (
          <div className="empty">
            {activeId ? '（空会话）' : '输入首条任务开始新会话；agent 与 CLI 端同源，会话数据互通。'}
          </div>
        )}
        {chat.items.map((item, i) => (
          <Item key={i} item={item} sessionId={activeId} running={running} />
        ))}
        <div ref={bottomRef} />
      </div>
      <Composer
        running={running}
        disabled={sidecar === 'dead'}
        fileHits={fileHits}
        onQueryFiles={queryFiles}
        onClearFiles={() => setFileHits([])}
        onSubmit={submit}
        onAbort={() => activeId && send({ type: 'abort', sessionId: activeId })}
      />
    </div>
  )
}

function Header(props: {
  sessions: SessionRecord[]
  activeId?: string
  live: boolean
  sidecar: SidecarState
  onSelect: (id: string) => void
  onNew: () => void
}) {
  return (
    <div className="header">
      <select
        value={props.activeId ?? ''}
        onChange={(e) => e.target.value && props.onSelect(e.target.value)}
        title="切换会话"
      >
        <option value="">— 选择会话 —</option>
        {props.sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {(s.title ?? s.id.slice(0, 8)) + (s.status === 'running' ? ' ⏵' : '')}
          </option>
        ))}
      </select>
      <button onClick={props.onNew} title="新建会话">＋</button>
      <span className={`dot ${props.sidecar === 'ready' ? (props.live ? 'live' : 'idle') : 'dead'}`} title={`内核: ${props.sidecar}${props.live ? ' · 流已连接' : ''}`} />
    </div>
  )
}

function Toolbar(props: {
  sessionId: string
  models: ModelEntry[]
  domains: DomainEntry[]
  planMode: string
  running: boolean
}) {
  const currentModel = props.models.find((m) => m.current)
  const currentDomain = props.domains.find((d) => d.current)
  return (
    <div className="toolbar">
      <select
        value={currentModel?.id ?? ''}
        disabled={props.running || props.models.length === 0}
        title="切换模型（仅空闲时；保留历史）"
        onChange={(e) => {
          if (e.target.value) {
            send({ type: 'switchModel', sessionId: props.sessionId, modelId: e.target.value })
            send({ type: 'listPickers', sessionId: props.sessionId })
          }
        }}
      >
        {props.models.length === 0 && <option value="">模型</option>}
        {props.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.alias || m.id}（{m.provider}）
          </option>
        ))}
      </select>
      <select
        value={currentDomain?.key ?? 'auto'}
        disabled={props.domains.length === 0}
        title="切换星域。⚠ 会话中途切换会使前缀缓存整体失效（成本约 10 倍+），建议新会话时选择"
        onChange={(e) => {
          send({ type: 'setDomain', sessionId: props.sessionId, key: e.target.value })
          send({ type: 'listPickers', sessionId: props.sessionId })
        }}
      >
        {props.domains.length === 0 && <option value="auto">星域</option>}
        {props.domains.map((d) => (
          <option key={d.key} value={d.key} title={d.motto}>
            {d.name}
          </option>
        ))}
      </select>
      {props.planMode === 'planning' && <span className="badge plan">📋 Plan Mode</span>}
    </div>
  )
}

function TodoPanel({ todos }: { todos: ChatState['todos'] }) {
  const doneCount = todos.filter((t) => t.status === 'completed').length
  return (
    <details className="todo-panel" open>
      <summary>
        任务清单 {doneCount}/{todos.length}
      </summary>
      <ul>
        {todos.map((t) => (
          <li key={t.id || t.content} className={t.status}>
            {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : t.status === 'cancelled' ? '✕' : '○'} {t.content}
          </li>
        ))}
      </ul>
    </details>
  )
}

/** 工具输入里常见的文件路径字段，用于渲染跳转链接。 */
function toolFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  for (const key of ['path', 'file_path', 'filePath', 'file']) {
    const v = o[key]
    if (typeof v === 'string' && v && !v.startsWith('/')) return v
  }
  return undefined
}

function Item({ item, sessionId, running }: { item: ChatItem; sessionId?: string; running: boolean }) {
  switch (item.kind) {
    case 'user':
      return <div className="msg user">{item.text}</div>
    case 'assistant':
      return <div className="msg assistant">{item.text}</div>
    case 'thinking':
      return (
        <details className="msg thinking">
          <summary>思考过程</summary>
          <pre>{item.text}</pre>
        </details>
      )
    case 'tool': {
      const filePath = toolFilePath(item.input)
      return (
        <details className={`msg tool ${item.isError ? 'error' : ''}`}>
          <summary>
            🔧 {item.name}
            {filePath && (
              <a
                className="file-link"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  send({ type: 'openFile', path: filePath })
                }}
              >
                {filePath}
              </a>
            )}
            {item.isError ? ' ⚠' : ''}
          </summary>
          <pre className="tool-input">{safeJson(item.input)}</pre>
          {item.result && <pre className="tool-result">{truncate(item.result, 4000)}</pre>}
        </details>
      )
    }
    case 'approval':
      return (
        <div className="msg approval">
          <div>
            🛡 <b>{item.toolName}</b> 请求执行
          </div>
          <pre>{truncate(safeJson(item.input), 1200)}</pre>
          {item.decision ? (
            <div className="decision">{item.decision === 'approve' ? '✓ 已批准' : `✗ ${item.decision}`}</div>
          ) : (
            <div className="actions">
              <button
                className="approve"
                onClick={() => sessionId && send({ type: 'approval', sessionId, requestId: item.requestId, decision: 'approve' })}
              >
                批准
              </button>
              <button
                className="deny"
                onClick={() => sessionId && send({ type: 'approval', sessionId, requestId: item.requestId, decision: 'deny' })}
              >
                拒绝
              </button>
            </div>
          )}
        </div>
      )
    case 'question':
      return <QuestionCard toolUseId={item.toolUseId} questions={item.questions} sessionId={sessionId} running={running} />
    case 'info':
      return <div className="msg info">{item.text}</div>
  }
}

/**
 * ask_user_question 结构化提问卡。答案不走新 API——组装成普通用户消息回传
 * （与桌面端同一约定，server 侧 ask_user_question 工具只回占位符 + endTurn）。
 */
function QuestionCard(props: { toolUseId: string; questions: QuestionSpec[]; sessionId?: string; running: boolean }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [sent, setSent] = useState(false)

  const toggle = (qid: string, option: string, multi: boolean) => {
    setPicked((prev) => {
      const cur = prev[qid] ?? []
      if (!multi) return { ...prev, [qid]: [option] }
      return { ...prev, [qid]: cur.includes(option) ? cur.filter((o) => o !== option) : [...cur, option] }
    })
  }

  const submit = () => {
    if (!props.sessionId || sent) return
    const lines = props.questions.map((q) => {
      const ans = picked[q.id]?.join('、') || '（未选择）'
      return props.questions.length > 1 ? `${q.prompt}: ${ans}` : ans
    })
    const text = lines.join('\n')
    send({ type: props.running ? 'steer' : 'prompt', sessionId: props.sessionId, text })
    setSent(true)
  }

  return (
    <div className="msg question">
      {props.questions.map((q) => (
        <div key={q.id} className="q-block">
          <div className="q-prompt">❓ {q.prompt}</div>
          <div className="q-options">
            {q.options.map((opt) => (
              <button
                key={opt}
                className={picked[q.id]?.includes(opt) ? 'picked' : ''}
                disabled={sent}
                onClick={() => toggle(q.id, opt, q.allowMultiple === true)}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      ))}
      {sent ? (
        <div className="decision">✓ 已回答</div>
      ) : (
        <div className="actions">
          <button className="approve" onClick={submit} disabled={Object.keys(picked).length === 0}>
            提交回答
          </button>
        </div>
      )}
    </div>
  )
}

function Composer(props: {
  running: boolean
  disabled: boolean
  fileHits: string[]
  onQueryFiles: (q: string) => void
  onClearFiles: () => void
  onSubmit: (text: string) => void
  onAbort: () => void
}) {
  const [text, setText] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 编辑器右键「发送到天枢」→ 追加到草稿
  useEffect(() => {
    return onHostMessage((msg: HostMsg) => {
      if (msg.type === 'insertText') {
        setText((prev) => (prev ? `${prev}\n${msg.text}` : msg.text))
        textareaRef.current?.focus()
      }
    })
  }, [])

  /** 光标前最后一个 @token（未闭合的提及查询），无则 null。 */
  const mentionQuery = (value: string): string | null => {
    const m = /(?:^|\s)@([\w\-./]*)$/.exec(value)
    return m ? m[1] ?? '' : null
  }

  const onChange = (value: string) => {
    setText(value)
    const q = mentionQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (q === null) {
      props.onClearFiles()
      return
    }
    debounceRef.current = setTimeout(() => props.onQueryFiles(q), 200)
  }

  const pickFile = (path: string) => {
    setText((prev) => prev.replace(/(^|\s)@[\w\-./]*$/, `$1@file:${path} `))
    props.onClearFiles()
    textareaRef.current?.focus()
  }

  const fire = () => {
    const t = text.trim()
    if (!t) return
    props.onSubmit(t)
    setText('')
    props.onClearFiles()
  }

  const onDropFiles = (e: DragEvent) => {
    e.preventDefault()
    const uris: string[] = []
    const uriList = e.dataTransfer.getData('text/uri-list')
    if (uriList) {
      for (const line of uriList.split('\n')) {
        const t = line.trim()
        if (t && !t.startsWith('#')) uris.push(t)
      }
    }
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
      const f = e.dataTransfer.files[i]
      // Electron/VS Code may expose path on File
      const p = (f as File & { path?: string }).path
      if (p) uris.push(p)
    }
    if (uris.length === 0) return
    const mentions = uris
      .map((u) => {
        try {
          const path = decodeURIComponent(u.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1'))
          // Prefer basename-ish relative: strip to last meaningful segment chain
          const parts = path.split(/[/\\]/)
          // Keep last 3 segments as a soft relative hint when absolute
          return `@file:${parts.slice(-3).join('/')}`
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .join(' ')
    if (mentions) setText((prev) => (prev ? `${prev} ${mentions} ` : `${mentions} `))
  }

  return (
    <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={onDropFiles}>
      {props.fileHits.length > 0 && (
        <div className="mention-list">
          {props.fileHits.slice(0, 12).map((f) => (
            <div key={f} className="mention-item" onClick={() => pickFile(f)}>
              {f}
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={text}
        disabled={props.disabled}
        placeholder={props.running ? '运行中——输入将作为插话在下一工具边界注入' : '给天枢一个任务…（@ 提及文件，拖拽文件，Enter 发送，Shift+Enter 换行）'}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            fire()
          }
          if (e.key === 'Escape') props.onClearFiles()
        }}
      />
      <div className="composer-actions">
        {props.running && (
          <button className="abort" onClick={props.onAbort} title="中止当前运行">
            ■ 中止
          </button>
        )}
        <button onClick={fire} disabled={props.disabled || !text.trim()}>
          {props.running ? '插话' : '发送'}
        </button>
      </div>
    </div>
  )
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? ''
  } catch {
    return String(v)
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} 字符已截断)` : s
}
