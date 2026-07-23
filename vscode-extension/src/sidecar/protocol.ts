/**
 * Sidecar 协议类型子集。
 *
 * ⚠ 事实源是 dev 仓 `src/server/protocol.ts`（Apache 2.0 开源侧）。本文件是
 * 插件消费所需的最小子集手工镜像——server 契约变更时同步更新（未知事件类型
 * 在消费端一律容错忽略，向后兼容）。不要在此文件添加 server 端没有的字段。
 */

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted'

export type ApprovalMode = 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions'

/** SSE 事件类型——插件 P0 消费的子集；未列出的类型按透传处理。 */
export type KnownEventType =
  | 'user'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use'
  | 'tool_result'
  | 'turn_complete'
  | 'phase'
  | 'approval_required'
  | 'approval_resolved'
  | 'status'
  | 'error'
  | 'todo_state'
  | 'steer_queued'
  | 'plan_mode'
  | 'plan_submitted'
  | 'user_question'
  | 'model_switched'
  | 'domain_changed'
  | 'resume_offer'
  | 'done'
  | 'tool_delegate'

export interface SessionEvent {
  seq: number
  ts: number
  type: string
  data: Record<string, unknown>
}

export interface SessionRecord {
  id: string
  status: SessionStatus
  createdAt: number
  updatedAt: number
  cwd: string
  title?: string
  currentPhase?: string
  lastSeq: number
  error?: string
  pendingApprovals: number
  approvalMode?: ApprovalMode
}

export interface CreateSessionRequest {
  cwd: string
  title?: string
  prompt?: string
  approvalMode?: ApprovalMode
  model?: string
  domain?: string
}

export interface ApprovalAnswer {
  decision: 'approve' | 'deny'
  editedInput?: Record<string, unknown>
  remember?: boolean
}

/** PlusMenu — GET /sessions/:id/models 条目。 */
export interface ModelEntry {
  id: string
  alias: string
  provider: string
  contextWindow?: number
  current: boolean
}

/** GET /sessions/:id/git/working-tree 条目 — 相对任务基线的单文件变更。 */
export interface WorkingTreeFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  additions: number
  deletions: number
}

/** PlusMenu — GET /sessions/:id/domains 条目（key: 'auto' | domainId）。 */
export interface DomainEntry {
  key: string
  name: string
  motto: string
  meta: string
  current: boolean
}
