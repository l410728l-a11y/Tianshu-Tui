/** webview ↔ 扩展宿主 postMessage 桥（webview 侧）。 */

export interface SessionEvent {
  seq: number
  ts: number
  type: string
  data: Record<string, unknown>
}

export interface SessionRecord {
  id: string
  status: string
  createdAt: number
  updatedAt: number
  cwd: string
  title?: string
  lastSeq: number
  pendingApprovals: number
}

export interface ModelEntry {
  id: string
  alias: string
  provider: string
  current: boolean
}

export interface DomainEntry {
  key: string
  name: string
  motto: string
  current: boolean
}

export type HostMsg =
  | { type: 'sessions'; sessions: SessionRecord[]; activeSessionId?: string }
  | { type: 'sessionCreated'; session: SessionRecord }
  | { type: 'sessionAttached'; sessionId: string }
  | { type: 'event'; sessionId: string; event: SessionEvent }
  | { type: 'streamState'; sessionId: string; live: boolean }
  | { type: 'sidecarState'; state: 'starting' | 'ready' | 'dead'; detail?: string }
  | { type: 'pickers'; sessionId: string; models: ModelEntry[]; domains: DomainEntry[] }
  | { type: 'files'; reqId: number; files: string[] }
  | { type: 'insertText'; text: string }
  | { type: 'error'; message: string }

interface VsCodeApi {
  postMessage(msg: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

const vscode = acquireVsCodeApi()

export function send(msg: Record<string, unknown>): void {
  vscode.postMessage(msg)
}

export function onHostMessage(cb: (msg: HostMsg) => void): () => void {
  const handler = (e: MessageEvent) => cb(e.data as HostMsg)
  window.addEventListener('message', handler)
  return () => window.removeEventListener('message', handler)
}
