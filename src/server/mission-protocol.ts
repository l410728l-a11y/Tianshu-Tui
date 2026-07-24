/**
 * Mission protocol — the wire/persisted shape of a Mission (工程任务).
 *
 * P1 任务身份化：Mission 是桌面端导航的主对象，一个 Mission 可关联多个
 * Session（主会话、子 Agent、重试）。用户看到的是稳定任务标题和状态，
 * 而不是随机 Session ID。
 *
 * HARD CONSTRAINT: this module must stay a dependency-free LEAF (no imports,
 * not even type imports) — same contract as `protocol.ts`. The desktop
 * consumes these types via a relative TYPE-ONLY import, and its typecheck
 * follows every import in the graph; one careless import here would drag
 * server runtime modules into the frontend type graph.
 */

/** Mission 生命周期（P1 极简版；Phase 2 由 Projector 投影更丰富状态）。 */
export type MissionState = 'active' | 'completed' | 'archived'

export interface Mission {
  id: string
  title: string
  state: MissionState
  /** 项目标识（与桌面端 `lib/projects.ts` 的 projectId(cwd) 同算法派生）。 */
  projectId: string
  /** 关联的 session id 列表（主会话在前，后续 addSession 追加）。 */
  sessionIds: string[]
  createdAt: number
  updatedAt: number
}
