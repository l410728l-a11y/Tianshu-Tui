// Qliphoth 退化检测 —— 三柱对抗的已知失败形态（织命议事会 Phase 2）。
// 卡巴拉机制：失败 = 同职能过量，不是对立面——仁慈的失败是无边吞噬，
// 严厉的失败是为剪而烧。解药是接回配对极，不是撤掉职能。
// 铁律：纯函数、advisory（检测留痕给主控与面板，不硬拦会诊）。

import { pillarOf, type CouncilPillar } from './council-routing.js'
import type { CouncilAggregate, SeatContribution } from './council-plan.js'

export interface QliphothFlag {
  kind: 'golachab' | 'gamchicoth' | 'thagirion'
  pillar: CouncilPillar
  seat: string
  detail: string
}

/**
 * 检测首轮席位贡献中的柱级退化模式：
 *  - Golachab（为剪而烧）：约束柱席位只有 blocking 否决、零建设性产出
 *    （无 addition、无推荐备选）——否决失去配对的建设极。
 *  - Gamchicoth（吞噬容器）：扩张柱席位提出方案但零验收界——
 *    无任何 gate 声明且 addition 全部缺 files（无边界的扩张）。
 *  - Thagirion（假整合）：存在席位间冲突（需要整合）但平衡柱席位零产出——
 *    合成职能缺位，裁决退化为机械合并。
 *
 * 只检测首轮全稿（round≠2）；未知星域（自定义域）不参与柱级检测。
 */
export function detectQliphoth(
  contributions: readonly SeatContribution[],
  aggregate: CouncilAggregate,
): QliphothFlag[] {
  const flags: QliphothFlag[] = []
  for (const c of contributions) {
    if ((c.round ?? 1) !== 1) continue
    const pillar = pillarOf(c.authority)
    if (!pillar) continue

    if (pillar === 'constraint') {
      const hasBlocking = c.challenges.some(ch => ch.severity === 'blocking')
      const constructive = c.additions.length > 0 || c.alternatives.some(a => a.recommend)
      if (hasBlocking && !constructive) {
        flags.push({
          kind: 'golachab', pillar, seat: c.authority,
          detail: `约束柱 ${c.authority} 只有否决零建设（blocking challenge 无配对方案）——建议配对扩张席复审后再采纳该否决`,
        })
      }
    }

    if (pillar === 'expansion' && c.additions.length > 0) {
      const hasGate = c.challenges.some(ch => ch.gate?.trim())
      const hasFiles = c.additions.some(a => (a.files?.length ?? 0) > 0)
      if (!hasGate && !hasFiles) {
        flags.push({
          kind: 'gamchicoth', pillar, seat: c.authority,
          detail: `扩张柱 ${c.authority} 的方案零验收界（无 gate 声明、条目无 files）——无边界的扩张不可执行，建议打回补界`,
        })
      }
    }

    if (pillar === 'balance' && aggregate.conflicts.length > 0) {
      const empty = !c.summary.trim()
        && c.additions.length === 0 && c.risks.length === 0
        && c.challenges.length === 0 && c.alternatives.length === 0
      if (empty) {
        flags.push({
          kind: 'thagirion', pillar, seat: c.authority,
          detail: `平衡柱 ${c.authority} 在存在 ${aggregate.conflicts.length} 条冲突时零产出——合成职能缺位，裁决退化为机械合并`,
        })
      }
    }
  }
  return flags
}

/** 渲染检测结果为议事 markdown 段（空 flags 返回空数组，不渲染空段落）。 */
export function renderQliphothFlags(flags: readonly QliphothFlag[]): string[] {
  if (flags.length === 0) return []
  const zhKind: Record<QliphothFlag['kind'], string> = {
    golachab: 'Golachab·为剪而烧',
    gamchicoth: 'Gamchicoth·无界扩张',
    thagirion: 'Thagirion·假整合',
  }
  return [
    '## ⚠ 柱级退化检测（Qliphoth）',
    ...flags.map(f => `- **${zhKind[f.kind]}**（${f.seat}）：${f.detail}`),
    '',
  ]
}
