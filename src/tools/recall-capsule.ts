import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'
import { getCapsuleByStar, listCapsuleStars } from '../agent/seed-capsule-store.js'

interface RecallCapsuleInput {
  star: string
}

const DEFINITION: ToolDefinition = {
  name: 'recall_capsule',
  description:
    '按需拉取前辈星域封存的完整认知方法（seed capsule）。冻结前缀里每颗将星只有一行索引；当你想采用某种特定姿态时调用本工具（例如：瑶光——验证/复发纪律，天权——规划/权衡审查，天璇——卡住、需要新角度时）。胶囊正文落在本工具的结果里——不会改动已缓存的提示词前缀。',
  input_schema: {
    type: 'object',
    properties: {
      star: { type: 'string', description: '星域名，例如 瑶光 / 天权 / 天璇 / 天府 / 天枢。' },
    },
    required: ['star'],
  },
}

/** recall_capsule: 按需把某前辈星域的完整胶囊正文拉进工具结果（cache-safe）。 */
export function createRecallCapsuleTool(getCwd: () => string): Tool {
  return {
    definition: DEFINITION,
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const input = params.input as unknown as RecallCapsuleInput
      const cwd = getCwd() || params.cwd
      const star = (input.star ?? '').trim()
      if (!star) {
        return { content: 'recall_capsule: star is required.', isError: true }
      }

      const capsule = getCapsuleByStar(cwd, star)
      if (!capsule) {
        const known = listCapsuleStars(cwd)
        return {
          content: `recall_capsule: no capsule for "${star}". Known stars: ${known.join(', ') || '(none)'}.`,
          isError: true,
        }
      }

      return {
        content: capsule.block,
        uiContent: `recall capsule: ${capsule.star} (sealed ${capsule.sealedAt})`,
        isError: false,
      }
    },
    requiresApproval(): boolean { return false },
    isConcurrencySafe(): boolean { return true },
    isEnabled(): boolean { return true },
  }
}
