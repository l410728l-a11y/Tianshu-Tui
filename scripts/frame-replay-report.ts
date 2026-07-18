#!/usr/bin/env tsx
/**
 * P3-D 认知帧观测报告 CLI。
 *
 * 扫描会话目录下的 frames.jsonl（P3-D frame 全量记录），跑确定性回放对账
 * （fingerprint / quality / structure-flow 重算 / 硬线不变量），输出准入报告：
 * session 数、记录数、degraded 比例、divergence/violation 明细、六类反例
 * 逐类计数、准入结论。纯读，不写任何状态。
 *
 * 用法：
 *   npm exec -- tsx scripts/frame-replay-report.ts            # 当前项目的会话目录
 *   npm exec -- tsx scripts/frame-replay-report.ts <sessions-dir>  # 显式指定目录
 *
 * 并发容错：JSONL parse 失败的行跳过并计 warning（trim 的 read→rewrite 与
 * 本工具读取存在竞态，截断行为主容错）；mtime 在最近 10 分钟内的
 * frames.jsonl 视为活跃会话跳过（不用 cleanExit 单判——崩溃 session 永远
 * 没有该字段，会被永久排除）。
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { sessionsDir } from '../src/config/paths.js'
import {
  buildAdmissionReport,
  parseFrameLines,
  FRAME_CLASS_KEYS,
  FRAME_CLASS_LABELS,
  type SessionFrames,
} from '../src/agent/frame-replay-report.js'

const ACTIVE_WINDOW_MS = 10 * 60 * 1000

const root = process.argv[2] ?? sessionsDir(process.cwd())
if (!existsSync(root)) {
  console.error(`会话目录不存在：${root}`)
  process.exit(1)
}

const sessions: SessionFrames[] = []
let skippedActive = 0
const now = Date.now()

for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const framesPath = join(root, entry.name, 'frames.jsonl')
  if (!existsSync(framesPath)) continue
  const stat = statSync(framesPath)
  if (now - stat.mtimeMs < ACTIVE_WINDOW_MS) {
    skippedActive++
    continue
  }
  const { records, parseWarnings } = parseFrameLines(readFileSync(framesPath, 'utf-8'))
  if (records.length === 0 && parseWarnings === 0) continue
  sessions.push({ sessionId: entry.name, records, parseWarnings })
}

const report = buildAdmissionReport(sessions)

console.log('# P3-D 认知帧观测报告')
console.log(`扫描目录：${root}`)
console.log(`会话数：${report.sessionCount}（跳过活跃会话 ${skippedActive} 个）`)
console.log(`记录数：${report.recordCount}，parse warning：${report.parseWarnings}`)
console.log(`degraded 记录：${report.degradedCount}（${(report.degradedRatio * 100).toFixed(1)}%）`)
console.log('')
console.log('## 回放对账')
console.log(`divergence：${report.replay.divergences.length}`)
for (const d of report.replay.divergences.slice(0, 20)) {
  console.log(`  - turn=${d.turn} ${d.field}: recorded=${JSON.stringify(d.recorded)} recomputed=${JSON.stringify(d.recomputed)}`)
}
console.log(`hard-line violation：${report.replay.violations.length}`)
for (const v of report.replay.violations.slice(0, 20)) {
  console.log(`  - turn=${v.turn} [${v.rule}] ${v.detail}`)
}
console.log('')
console.log('## 六类反例覆盖（非互斥，逐类计数）')
for (const key of FRAME_CLASS_KEYS) {
  const mark = report.classCounts[key] > 0 ? '✓' : '✗'
  console.log(`  ${mark} ${FRAME_CLASS_LABELS[key]}: ${report.classCounts[key]}`)
}
console.log('')
console.log(`## 结论：${report.admitted ? '满足 P3-D 准入' : '不满足 P3-D 准入'}`)
for (const item of report.missing) console.log(`  - ${item}`)
process.exit(report.admitted ? 0 : 2)
