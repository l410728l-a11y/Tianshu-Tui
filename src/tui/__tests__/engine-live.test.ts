import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LiveEngine, type LiveRegionLine } from '../engine/live-engine.js'

function mockStdout(): { stdout: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = []
  const stdout = {
    write: (chunk: string) => { writes.push(chunk); return true },
    columns: 80,
    rows: 24,
  } as unknown as NodeJS.WriteStream
  return { stdout, writes }
}

describe('LiveEngine', () => {
  it('first render writes lines directly without cursor manipulation', () => {
    const { stdout, writes } = mockStdout()
    const engine = new LiveEngine({ stdout })
    const lines: LiveRegionLine[] = [
      { text: 'line 1' },
      { text: 'line 2' },
    ]
    engine.render(lines)
    const output = writes.join('')
    assert.ok(output.includes('line 1'))
    assert.ok(output.includes('line 2'))
    // 首次渲染不使用 cursor save/restore
    assert.ok(!output.includes('\x1B[s'))
  })

  it('incremental redraw uses relative cursor (no SAVE/RESTORE), sync-wrapped', () => {
    const { stdout, writes } = mockStdout()
    const engine = new LiveEngine({ stdout })

    engine.render([{ text: 'initial' }])
    writes.length = 0 // 清空

    engine.render([{ text: 'updated' }])
    const output = writes.join('')
    // cursor-resident 协议：相对光标、无 SAVE/RESTORE、CSI 2026 同步输出包裹
    assert.ok(output.includes('updated'))
    assert.ok(!output.includes('\x1B[s'), '不应使用 SAVE_CURSOR')
    assert.ok(!output.includes('\x1B[u'), '不应使用 RESTORE_CURSOR')
    assert.ok(output.startsWith('\x1B[?2026h') && output.endsWith('\x1B[?2026l'), '应被同步输出包裹')
  })

  it('clear erases live region and resets state (no SAVE/RESTORE)', () => {
    const { stdout, writes } = mockStdout()
    const engine = new LiveEngine({ stdout })

    engine.render([{ text: 'some content' }])
    writes.length = 0

    engine.clear()
    const output = writes.join('')
    // clear：擦到屏幕末，不使用绝对光标
    assert.ok(output.includes('\x1B[0J'), '应擦除到屏幕末')
    assert.ok(!output.includes('\x1B[s'), '不应使用 SAVE_CURSOR')
  })

  it('renderLine is a convenience for single-line live region', () => {
    const { stdout, writes } = mockStdout()
    const engine = new LiveEngine({ stdout })
    engine.renderLine('streaming text...')
    const output = writes.join('')
    assert.ok(output.includes('streaming text...'))
  })

  it('reset clears internal state for full redraw', () => {
    const { stdout, writes } = mockStdout()
    const engine = new LiveEngine({ stdout })

    engine.render([{ text: 'frame 1' }])
    writes.length = 0

    engine.reset()
    engine.render([{ text: 'fresh start' }])
    const output = writes.join('')
    // reset 后首次渲染不使用 cursor manipulation
    assert.ok(!output.includes('\x1B[s'))
  })

  it('line cache prevents redundant redraws of unchanged lines', () => {
    const { stdout, writes } = mockStdout()
    const engine = new LiveEngine({ stdout })

    // 先渲染两行
    engine.render([
      { text: '\x1B[32mstatic\x1B[0m' },
      { text: '\x1B[33mchanging\x1B[0m' },
    ])
    writes.length = 0

    // 只改动第二行
    engine.render([
      { text: '\x1B[32mstatic\x1B[0m' },
      { text: '\x1B[34mchanged\x1B[0m' },
    ])
    const output = writes.join('')
    // 第一行不变时不应完整重绘（通过 cursorDown 跳过）
    assert.ok(output.includes('changed'))
  })
})

describe('LiveEngine · CPR 自愈（外来写入污染检出与恢复）', () => {
  it('CPR 响应与基线一致 → 不判污染，H2 短路照常跳过无变化帧', () => {
    const { stdout, writes } = mockStdout()
    let pollutedCalls = 0
    const engine = new LiveEngine({ stdout, onPolluted: () => { pollutedCalls++ } })
    const lines: LiveRegionLine[] = [{ text: 'a' }, { text: 'b' }]

    engine.render(lines)
    engine.noteCpr(24, 2) // 建立基线
    engine.noteCpr(24, 2) // 一致
    assert.equal(pollutedCalls, 0)

    writes.length = 0
    engine.render(lines) // 无变化 → H2 短路
    assert.equal(writes.join(''), '')
  })

  it('CPR 响应偏离基线 → 标记污染并回调，下一帧跳过 H2 走恢复重铺', () => {
    const { stdout, writes } = mockStdout()
    let pollutedCalls = 0
    const engine = new LiveEngine({ stdout, onPolluted: () => { pollutedCalls++ } })
    const lines: LiveRegionLine[] = [{ text: 'a' }, { text: 'b' }]

    engine.render(lines)
    engine.noteCpr(24, 2) // 基线
    engine.noteCpr(24, 61) // 外来文本接在末行后 → 列偏离
    assert.equal(pollutedCalls, 1, '偏离基线应立即回调 onPolluted')

    writes.length = 0
    engine.render(lines) // 行内容未变——H2 必须被污染标记绕过
    const out = writes.join('')
    assert.ok(out.includes('\x1B[0J'), '恢复路径应擦到屏幕末')
    assert.ok(out.includes('a') && out.includes('b'), '恢复路径应完整重铺帧')
    // 恢复后基线作废：下一次 noteCpr 重建（不判污染）
    engine.noteCpr(23, 2)
    assert.equal(pollutedCalls, 1)
  })

  it('恢复爬升量以 CPR 报告行封顶——绝不爬出视口顶', () => {
    const { stdout, writes } = mockStdout()
    const engine = new LiveEngine({ stdout, onPolluted: () => {} })
    const lines: LiveRegionLine[] = Array.from({ length: 5 }, (_, i) => ({ text: `L${i}` }))
    engine.render(lines)
    engine.noteCpr(24, 3) // 基线
    engine.noteCpr(2, 40) // 污染 + 报告光标在第 2 行 → 爬升上限 1
    writes.length = 0
    engine.render(lines)
    const out = writes.join('')
    assert.ok(out.includes('\x1B[1A'), '爬升应被 min(5-1, 2-1)=1 封顶')
    assert.ok(!out.includes('\x1B[4A'), '不应按 lastDisplayRows-1 全量爬升')
  })

  it('区域离屏（clear 后）的 CPR 响应只更新基线，不判污染', () => {
    const { stdout } = mockStdout()
    let pollutedCalls = 0
    const engine = new LiveEngine({ stdout, onPolluted: () => { pollutedCalls++ } })
    engine.render([{ text: 'x' }])
    engine.noteCpr(24, 2)
    engine.clear()
    engine.noteCpr(10, 1) // clear 期间光标移动属正常（commit 协议）
    assert.equal(pollutedCalls, 0)
  })

  it('requestProbe 节流与 pending 去重：pending 中不重发，响应后仍受最小间隔约束', () => {
    const { stdout, writes } = mockStdout()
    let probes = 0
    const engine = new LiveEngine({ stdout, onProbeRequest: () => { probes++ } })
    engine.requestProbe()
    assert.equal(probes, 1)
    engine.requestProbe() // pending 中 → 不重发
    assert.equal(probes, 1)
    engine.noteCpr(24, 1) // 响应到达，pending 清除
    engine.requestProbe() // 但距上次探针 < 1000ms → 节流
    assert.equal(probes, 1)
    void writes
  })

  it('suppressProbe（overlay alt screen 期间）：不发探针、CPR 响应不判污染', () => {
    const { stdout } = mockStdout()
    let probes = 0
    let pollutedCalls = 0
    const engine = new LiveEngine({
      stdout,
      onProbeRequest: () => { probes++ },
      onPolluted: () => { pollutedCalls++ },
    })
    engine.render([{ text: 'main' }])
    engine.noteCpr(24, 2) // 主屏基线（render 帧后可能已发探针，归零再验证）

    // overlay 激活 → suppress
    engine.suppressProbe()
    probes = 0 // 归零，只验证 suppress 之后的探针行为
    engine.requestProbe() // alt screen 期间探针被抑制
    assert.equal(probes, 0, 'suppress 期间不发探针')

    // 模拟 overlay 在 alt screen 的 CPR 响应（位置与主屏基线不同）
    engine.noteCpr(10, 40)
    assert.equal(pollutedCalls, 0, 'suppress 期间 CPR 偏离不判污染')

    // overlay 退出 → resume，下一帧重建基线，不误判
    engine.resumeProbe()
    engine.noteCpr(24, 2) // resume 后基线已作废，此次只重建不判污染
    assert.equal(pollutedCalls, 0, 'resume 后首次 CPR 只重建基线')
  })
})
