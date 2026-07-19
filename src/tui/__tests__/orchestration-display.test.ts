/**
 * 编排状态徽章（GlanceBar）与 side-panel team 区块测试。
 *
 * 契约：
 *  1. GlanceBar 右区按优先级显示一个编排徽章：team 波次 > 在跑 worker > 终态未读。
 *  2. side-panel 在 team 运行中渲染 wave 区块：模式标签、总进度条、每波 glyph 行、
 *     超过 4 波折叠；无 teamModel 时不渲染。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatGlanceRight } from '../format/glance-bar.js'
import { renderSidePanel } from '../side-panel.js'
import type { TeamPanelModel } from '../team-panel-model.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

const baseGlance = { width: 120, density: 'compact' as const }

describe('GlanceBar 编排徽章', () => {
  it('在跑 worker >0：显示 ◐ N', () => {
    const out = stripAnsi(formatGlanceRight({ ...baseGlance, fleetRunning: 3 }, theme))
    assert.ok(out.includes('◐ 3'), out)
  })

  it('全部终态且有未读：显示 ✓ N', () => {
    const out = stripAnsi(formatGlanceRight({ ...baseGlance, fleetRunning: 0, fleetUnread: 2 }, theme))
    assert.ok(out.includes('✓ 2'), out)
    assert.ok(!out.includes('◐'), '无在跑时不显示 running 徽章')
  })

  it('team 波次优先于舰队徽章', () => {
    const out = stripAnsi(formatGlanceRight(
      { ...baseGlance, teamWave: { current: 2, total: 3 }, fleetRunning: 4, fleetUnread: 1 },
      theme,
    ))
    assert.ok(out.includes('◆ w2/3'), out)
    assert.ok(!out.includes('◐ 4'), 'team 运行中不重复显示舰队徽章')
  })

  it('无任何编排状态：无徽章', () => {
    const out = stripAnsi(formatGlanceRight({ ...baseGlance, fleetRunning: 0, fleetUnread: 0 }, theme))
    assert.ok(!out.includes('◐') && !out.includes('✓ 0') && !out.includes('◆ w'), out)
  })
})

const teamModel: TeamPanelModel = {
  mode: 'max',
  currentWave: 1,
  totalWaves: 2,
  dispatched: 3,
  blocked: [],
  waves: [
    { id: 'wave-1', taskIds: ['t1', 't2'], risk: 'low', reason: 'parallel-safe' },
    { id: 'wave-2', taskIds: ['t3'], risk: 'high', reason: 'shared files' },
  ],
  tasks: [
    { id: 't1', title: 'explore api', authority: 'pojun', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', files: [], status: 'done' },
    { id: 't2', title: 'map imports', authority: 'tianxuan', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', files: [], status: 'done' },
    { id: 't3', title: 'patch retry', authority: 'tianliang', profile: 'patcher', kind: 'patch', dependsOn: ['t1'], riskTier: 'high', files: [], status: 'running' },
  ],
}

describe('side-panel team 区块', () => {
  const baseInput = { columns: 28, todos: [], workers: [] }

  it('team 运行中渲染模式标签、进度条与每波 glyph 行', () => {
    const lines = renderSidePanel({ ...baseInput, teamModel }, theme).map(stripAnsi)
    const joined = lines.join('\n')
    assert.ok(joined.includes('◆ 团队'), 'section title')
    assert.ok(joined.includes('/team max'), 'mode label')
    assert.ok(joined.includes('2/3 · wave 2/2'), 'progress + wave label（currentWave 0-based → 显示 +1）')
    assert.ok(joined.includes('✓ wave-1 2/2'), '完成波 glyph')
    assert.ok(joined.includes('◐ wave-2 0/1'), '活动波 glyph')
  })

  it('无 teamModel 不渲染 team 区块', () => {
    const joined = renderSidePanel(baseInput, theme).map(stripAnsi).join('\n')
    assert.ok(!joined.includes('◆ 团队'), joined)
  })

  it('超过 4 波折叠为 ... +N waves', () => {
    const many: TeamPanelModel = {
      ...teamModel,
      totalWaves: 6,
      waves: Array.from({ length: 6 }, (_, i) => ({ id: `wave-${i + 1}`, taskIds: ['t1'], risk: 'low' as const, reason: '' })),
    }
    const joined = renderSidePanel({ ...baseInput, teamModel: many }, theme).map(stripAnsi).join('\n')
    assert.ok(joined.includes('... +2 waves'), joined)
  })
})
