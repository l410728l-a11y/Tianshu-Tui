/**
 * update_goal tool — model-driven goal lifecycle control.
 *
 * Lets the model actively declare paused/blocked/complete through a tool call,
 * instead of only relying on regex-detected "GOAL ACHIEVED" text output.
 *
 * Uses the same closure pattern as createDeliverTaskTool: the goal tracker ref
 * is captured at registration time, avoiding any ToolPipelineDeps plumbing.
 */
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { GoalTracker } from '../agent/goal-tracker.js'

type GoalTrackerRef = { current: GoalTracker | null }

export function createUpdateGoalTool(
  getTracker: () => GoalTracker | null,
  getSessionInfo?: () => { sessionId?: string; cwd?: string } | null,
): Tool {
  return {
    definition: {
      name: 'update_goal',
      description: `更新当前目标（goal）的生命周期状态。仅在有激活目标时可用。

### 何时调用
- 朝向目标的全部工作真正完成时，用 status="complete"。
- 外部条件阻断进展（依赖缺失、环境问题）时，用 status="blocked"。
- 需要用户先给出输入才能继续时，用 status="paused"。

### 参数
- status: paused | blocked | complete
- reason（可选）：简要说明为什么设置该状态。`,
      input_schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: '要设置的生命周期状态：paused、blocked 或 complete。',
          },
          reason: {
            type: 'string',
            description: '简要说明为什么设置该状态。',
          },
        },
        required: ['status'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const tracker = getTracker()
      if (!tracker) {
        return { content: '当前没有可更新的目标。', isError: true }
      }
      if (tracker.getStatus() !== 'active') {
        return {
          content: `目标当前状态为 ${tracker.getStatus()}，无法通过 update_goal 更新。`,
          isError: true,
        }
      }

      const status = params.input.status
      const reason = typeof params.input.reason === 'string' ? params.input.reason : undefined

      if (status !== 'paused' && status !== 'blocked' && status !== 'complete') {
        return {
          content: `无效状态「${status}」。允许：paused、blocked、complete。`,
          isError: true,
          errorKind: 'format_error',
        }
      }

      try {
        if (status === 'complete') {
          tracker.markComplete('model')
        } else if (status === 'blocked') {
          tracker.markBlocked(reason ?? 'Blocked by model', 'model')
        } else {
          tracker.pause(reason ?? 'Paused by model', 'model')
        }
        const sessionInfo = getSessionInfo?.()
        if (sessionInfo?.sessionId && sessionInfo.cwd) {
          try {
            const { saveGoalState } = await import('../agent/goal-persist.js')
            const { getSessionDir } = await import('../agent/session-persist.js')
            saveGoalState(getSessionDir(sessionInfo.cwd), sessionInfo.sessionId, tracker)
          } catch { /* best-effort */ }
        }
        return { content: `目标状态已更新为 ${status}。` }
      } catch (e) {
        return { content: `状态转换失败：${(e as Error).message}`, isError: true }
      }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}
