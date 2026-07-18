import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFrameRecorder, FRAMES_FILE } from '../frame-telemetry.js'
import type { CognitiveFrameRecord } from '../cognitive-frame-replay.js'

function makeRecord(turn: number): CognitiveFrameRecord {
  return {
    kind: 'cognitive-frame',
    v: 1,
    turn,
    phaseClass: 'explore',
    inputFingerprint: `fp-${turn}`,
    quality: {
      efe: 'measured', sensorium: 'measured', flow: 'measured', pal: 'measured',
      evidence: 'measured', user: 'measured', plan: 'measured', progress: 'measured',
    },
    facts: {
      efe: { epistemicValue: 0.15, pragmaticValue: 0.9, noveltyBonus: 0.2, precision: 0.9 },
      sensorium: { momentum: 1, momentumHasData: true, stability: 1 },
      flow: { score: 0.9, sampleCount: 4, requiredSamples: 4 },
      pal: { activeCases: 0, anyNeedsUser: false, anyStalled: false, hasPlannedProbes: false },
      evidence: { hasVerificationDebt: false, deliveryStatus: 'unverified', consecutiveFailures: 0 },
      user: { intervened: false },
      plan: { activePlanFile: false, planModeState: 'off' },
      progress: { todoCompletedDelta: 0 },
    },
    structureFlow: { mode: 'flow', relaxation: 0.25, planRecommendation: 'none', tddRecommendation: 'neutral', reasons: ['stable-execution'] },
    convergence: { level: 0, shouldAbort: false, abortCause: null },
  }
}

function readLines(cwd: string): string[] {
  return readFileSync(join(cwd, '.rivet', FRAMES_FILE), 'utf-8').trim().split('\n')
}

describe('createFrameRecorder', () => {
  let cwd: string
  let prevLite: string | undefined
  let prevFrame: string | undefined

  beforeEach(() => {
    prevLite = process.env['RIVET_TELEMETRY_LITE']
    prevFrame = process.env['RIVET_FRAME_TELEMETRY']
    delete process.env['RIVET_TELEMETRY_LITE']
    delete process.env['RIVET_FRAME_TELEMETRY']
    cwd = mkdtempSync(join(tmpdir(), 'rivet-frame-telemetry-'))
  })

  afterEach(() => {
    if (prevLite === undefined) delete process.env['RIVET_TELEMETRY_LITE']
    else process.env['RIVET_TELEMETRY_LITE'] = prevLite
    if (prevFrame === undefined) delete process.env['RIVET_FRAME_TELEMETRY']
    else process.env['RIVET_FRAME_TELEMETRY'] = prevFrame
    rmSync(cwd, { recursive: true, force: true })
  })

  it('① 默认落盘：无任何环境变量时记录写入 frames.jsonl 且可回读', async () => {
    const recorder = createFrameRecorder(cwd)
    assert.equal(recorder.enabled, true)
    recorder.write(makeRecord(1))
    recorder.write(makeRecord(2))
    await recorder.flush()

    const lines = readLines(cwd)
    assert.equal(lines.length, 2)
    const parsed = JSON.parse(lines[1]!) as CognitiveFrameRecord
    assert.equal(parsed.kind, 'cognitive-frame')
    assert.equal(parsed.turn, 2)
    assert.equal(parsed.facts.flow.score, 0.9)
  })

  it('② RIVET_FRAME_TELEMETRY=0 → enabled=false，不落盘', async () => {
    process.env['RIVET_FRAME_TELEMETRY'] = '0'
    const recorder = createFrameRecorder(cwd)
    assert.equal(recorder.enabled, false)
    recorder.write(makeRecord(1))
    await recorder.flush()
    assert.equal(existsSync(join(cwd, '.rivet', FRAMES_FILE)), false)
  })

  it('③ 开关联动：RIVET_TELEMETRY_LITE=0（主开关）时 frame 也不落盘', async () => {
    process.env['RIVET_TELEMETRY_LITE'] = '0'
    // 注意：FRAME 开关未设——主开关必须单独就能关掉子通道。
    const recorder = createFrameRecorder(cwd)
    assert.equal(recorder.enabled, false)
    recorder.write(makeRecord(1))
    await recorder.flush()
    assert.equal(existsSync(join(cwd, '.rivet', FRAMES_FILE)), false)
  })

  it('④ 写失败不阻断：不可写路径下 write/flush 均不抛', async () => {
    const recorder = createFrameRecorder('/dev/null')
    assert.doesNotThrow(() => recorder.write(makeRecord(1)))
    await assert.doesNotReject(() => recorder.flush())
  })

  it('⑤a 行数阈值 trim：超过 maxLines 即裁剪为尾部保留', async () => {
    const recorder = createFrameRecorder(cwd, undefined, { maxLines: 5 })
    for (let turn = 1; turn <= 9; turn++) recorder.write(makeRecord(turn))
    await recorder.flush()

    const lines = readLines(cwd)
    assert.equal(lines.length, 5, '应裁剪到 maxLines')
    const turns = lines.map(l => (JSON.parse(l) as CognitiveFrameRecord).turn)
    assert.deepEqual(turns, [5, 6, 7, 8, 9], '保留的是最新尾部')
  })

  it('⑤b 收尾 trim：续写既有超限文件，阈值路径未触发时 flush 也保证有界', async () => {
    // 预置一个已超限的 frames.jsonl（模拟历史 session 遗留）。
    mkdirSync(join(cwd, '.rivet'), { recursive: true })
    const stale = Array.from({ length: 8 }, (_, i) => JSON.stringify(makeRecord(100 + i))).join('\n') + '\n'
    writeFileSync(join(cwd, '.rivet', FRAMES_FILE), stale, 'utf-8')

    const recorder = createFrameRecorder(cwd, undefined, { maxLines: 6 })
    recorder.write(makeRecord(200)) // 首写读盘初始化计数 8 → 追加后 9 > 6，触发 trim
    await recorder.flush()

    const lines = readLines(cwd)
    assert.equal(lines.length, 6)
    const turns = lines.map(l => (JSON.parse(l) as CognitiveFrameRecord).turn)
    assert.equal(turns[turns.length - 1], 200, '新记录必须在尾部保留')
  })

  it('⑤c flush 幂等：连续两次 flush 不重复裁剪、不抛错', async () => {
    const recorder = createFrameRecorder(cwd, undefined, { maxLines: 5 })
    recorder.write(makeRecord(1))
    await recorder.flush()
    await recorder.flush()
    assert.equal(readLines(cwd).length, 1)
  })
})
