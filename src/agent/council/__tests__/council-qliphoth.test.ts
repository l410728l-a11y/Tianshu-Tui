import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectQliphoth } from '../council-qliphoth.js'
import type { CouncilAggregate, SeatContribution } from '../council-plan.js'

function seat(over: Partial<SeatContribution> & { authority: string }): SeatContribution {
  return { summary: '有内容的摘要', additions: [], risks: [], challenges: [], alternatives: [], ...over }
}
function agg(over: Partial<CouncilAggregate> = {}): CouncilAggregate {
  return { decisions: [], conflicts: [], mergedItems: [], ...over }
}

describe('detectQliphoth — 三柱退化检测（纯函数、advisory）', () => {
  it('Golachab：约束柱席位只有 blocking 否决、零建设性产出 → flag', () => {
    const flags = detectQliphoth([
      seat({ authority: 'huagai', challenges: [{ text: '全都不行', severity: 'blocking' }] }),
    ], agg())
    assert.equal(flags.length, 1)
    assert.equal(flags[0]!.kind, 'golachab')
    assert.equal(flags[0]!.seat, 'huagai')
    assert.equal(flags[0]!.pillar, 'constraint')
  })

  it('Golachab 反例：约束柱否决但同时给出 addition 或推荐备选 → 不 flag', () => {
    const withAddition = detectQliphoth([
      seat({ authority: 'huagai', challenges: [{ text: 'X 不行', severity: 'blocking' }], additions: [{ id: 'A', title: 't', detail: 'd' }] }),
    ], agg())
    assert.equal(withAddition.length, 0)
    const withAlt = detectQliphoth([
      seat({ authority: 'tianquan', challenges: [{ text: 'X 不行', severity: 'blocking' }], alternatives: [{ proposal: '换 Y', recommend: true, rationale: 'r' }] }),
    ], agg())
    assert.equal(withAlt.length, 0)
  })

  it('Gamchicoth：扩张柱席位有 addition 但零验收门（无 gate 且 addition 无 files）→ flag', () => {
    const flags = detectQliphoth([
      seat({ authority: 'pojun', additions: [{ id: 'A', title: '大重构', detail: '全部推翻' }] }),
    ], agg())
    assert.equal(flags.length, 1)
    assert.equal(flags[0]!.kind, 'gamchicoth')
    assert.equal(flags[0]!.pillar, 'expansion')
  })

  it('Gamchicoth 反例：addition 带 files 或席位声明了 gate → 不 flag', () => {
    const withFiles = detectQliphoth([
      seat({ authority: 'pojun', additions: [{ id: 'A', title: 't', detail: 'd', files: ['src/x.ts'] }] }),
    ], agg())
    assert.equal(withFiles.length, 0)
    const withGate = detectQliphoth([
      seat({ authority: 'tianji', additions: [{ id: 'A', title: 't', detail: 'd' }], challenges: [{ text: '必须过类型', gate: 'npx tsc --noEmit' }] }),
    ], agg())
    assert.equal(withGate.length, 0)
  })

  it('Thagirion：存在席位间冲突但平衡柱席位零产出（空摘要且无任何贡献）→ flag', () => {
    const flags = detectQliphoth([
      seat({ authority: 'yaoguang', summary: '' }),
      seat({ authority: 'pojun', additions: [{ id: 'A', title: 't', detail: 'd', files: ['src/x.ts'] }] }),
    ], agg({ conflicts: [{ description: 'd', left: 'L', right: 'R', key: 'k', status: 'open' }] }))
    assert.equal(flags.filter(f => f.kind === 'thagirion').length, 1)
  })

  it('Thagirion 反例：无冲突时平衡柱空产出不 flag（无需整合）', () => {
    const flags = detectQliphoth([
      seat({ authority: 'yaoguang', summary: '' }),
    ], agg())
    assert.equal(flags.filter(f => f.kind === 'thagirion').length, 0)
  })

  it('非三柱星域席位（如天璇以外的未知域）不参与检测，不 flag 不抛错', () => {
    const flags = detectQliphoth([
      seat({ authority: 'unknown-domain', challenges: [{ text: 'x', severity: 'blocking' }] }),
    ], agg())
    assert.equal(flags.length, 0)
  })

  it('r2 贡献（round=2）不参与检测（退化检测只看首轮全稿）', () => {
    const flags = detectQliphoth([
      seat({ authority: 'huagai', round: 2, challenges: [{ text: '全都不行', severity: 'blocking' }] }),
    ], agg())
    assert.equal(flags.length, 0)
  })
})
