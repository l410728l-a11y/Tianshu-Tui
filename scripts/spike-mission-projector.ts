#!/usr/bin/env -S npx tsx
/**
 * Spike: MissionProjector 重放校验 + 事件可见性缺口清单
 *
 * 读取桌面会话事件日志（~/.rivet/desktop/sessions/<id>/events.jsonl），
 * 对 ≥10 个会话执行三重校验：
 *   1. 确定性 — foldMission 双跑 deepStrictEqual（同一日志结果不变）
 *   2. 全量≡增量 — foldMission(evs) ≡ evs.reduce(stepMission, EMPTY)
 *   3. 重连语义 — 随机切分点分批增量 vs 全量
 *
 * 输出：一致性通过率 + 目标事件类型在流上的实际可见性清单（council max 全流程缺口）。
 *
 * 用法：
 *   npx tsx scripts/spike-mission-projector.ts
 *   npx tsx scripts/spike-mission-projector.ts --session-dir /custom/path
 *   npx tsx scripts/spike-mission-projector.ts --min-sessions 5
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { deepStrictEqual } from 'node:assert'
import { foldMission, stepMission, EMPTY_MISSION, type MissionSnapshot } from '../desktop/src/state/mission-projector.js'

// ── 配置 ──────────────────────────────────────────────

const SESSION_DIR = process.argv.includes('--session-dir')
  ? process.argv[process.argv.indexOf('--session-dir') + 1]!
  : defaultSessionDir()

const MIN_SESSIONS = (() => {
  const idx = process.argv.indexOf('--min-sessions')
  return idx >= 0 ? parseInt(process.argv[idx + 1]!, 10) || 10 : 10
})()

const MIN_EVENTS = 20 // 事件太少跳过的阈值

// ── 类型 ──────────────────────────────────────────────

interface SessionEvent {
  seq: number
  ts: number
  type: string
  data: Record<string, unknown>
}

interface ValidationResult {
  sessionId: string
  eventCount: number
  determinism: boolean
  fullVsIncremental: boolean
  reconnect: boolean
  eventTypes: string[]
}

interface GapReport {
  /** 计划关注的事件类型 → 在 ≥1 个会话中出现的计数 */
  presence: Record<string, number>
  /** 在所有采样会话中均未出现的事件类型 */
  missing: string[]
}

// ── 主流程 ────────────────────────────────────────────

function main(): void {
  console.log('=== Spike: MissionProjector 重放校验 ===\n')

  const sessionIds = listSessions(SESSION_DIR, MIN_SESSIONS)
  console.log(`会话目录: ${SESSION_DIR}`)
  console.log(`采样数量: ${sessionIds.length}（要求 ≥ ${MIN_SESSIONS}）\n`)

  if (sessionIds.length < MIN_SESSIONS) {
    console.log(`⚠️  仅有 ${sessionIds.length} 个会话，不足 ${MIN_SESSIONS}——降级运行`)
  }

  const results: ValidationResult[] = []
  const allEventTypes = new Set<string>()

  for (const sid of sessionIds) {
    const eventsPath = path.join(SESSION_DIR, sid, 'events.jsonl')
    if (!fs.existsSync(eventsPath)) continue

    const events = readEvents(eventsPath)
    if (events.length < MIN_EVENTS) continue

    console.log(`${sid} — ${events.length} events ...`)

    const r = runValidations(sid, events)
    results.push(r)

    for (const t of r.eventTypes) allEventTypes.add(t)

    const status = r.determinism && r.fullVsIncremental && r.reconnect ? '✅' : '❌'
    console.log(`  ${status} determinism=${r.determinism} fullVsIncremental=${r.fullVsIncremental} reconnect=${r.reconnect}`)
  }

  // ── 汇总 ──────────────────────────────────────────

  console.log('\n=== 汇总 ===\n')

  const passed = results.filter(r => r.determinism && r.fullVsIncremental && r.reconnect)
  console.log(`总采样: ${results.length} 个会话`)
  console.log(`三重全过: ${passed.length}/${results.length}`)
  console.log(`确定性: ${results.filter(r => r.determinism).length}/${results.length}`)
  console.log(`全量≡增量: ${results.filter(r => r.fullVsIncremental).length}/${results.length}`)
  console.log(`重连语义: ${results.filter(r => r.reconnect).length}/${results.length}`)

  // ── 缺口清单 ──────────────────────────────────────

  const gap = buildGapReport(results)
  console.log('\n=== 事件可见性缺口清单 ===\n')
  console.log('目标事件类型在采样会话中的出现情况：')
  for (const [evType, count] of Object.entries(gap.presence).sort(([, a], [, b]) => b - a)) {
    const pct = results.length > 0 ? ((count / results.length) * 100).toFixed(0) : '0'
    console.log(`  ${evType}: ${count}/${results.length} (${pct}%)`)
  }
  console.log(`\n零出现: ${gap.missing.join(', ') || '（无——全部目标类型至少在一个会话中出现）'}`)

  // ── 出口 ──────────────────────────────────────────

  if (passed.length === results.length && results.length >= MIN_SESSIONS) {
    console.log('\n✅ Spike 通过 — 投影层确定性已验证')
    process.exit(0)
  } else if (passed.length < results.length) {
    console.log(`\n❌ 一致性门禁未过 — ${results.length - passed.length} 个会话失败`)
    process.exit(1)
  } else {
    console.log(`\n⚠️  采样不足（${results.length} < ${MIN_SESSIONS}）— 部分门禁降级，不阻塞`)
    process.exit(0)
  }
}

// ── 实现 ──────────────────────────────────────────────

function defaultSessionDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
  const rivetHome = process.env.RIVET_HOME ?? path.join(home, '.rivet')
  const desktopDir = process.env.RIVET_DESKTOP_DIR ?? path.join(rivetHome, 'desktop')
  return process.env.RIVET_DESKTOP_SESSION_DIR ?? path.join(desktopDir, 'sessions')
}

function listSessions(dir: string, max: number): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .slice(0, max)
}

function readEvents(filePath: string): SessionEvent[] {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const events: SessionEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed) as SessionEvent)
    } catch {
      // 跳过损坏行
    }
  }
  return events
}

function runValidations(sessionId: string, events: SessionEvent[]): ValidationResult {
  const cast = events as Parameters<typeof foldMission>[0]

  // 1. 确定性：双跑 deepStrictEqual
  const run1 = foldMission(cast)
  const run2 = foldMission(cast)
  let determinism = false
  try {
    deepStrictEqual(run1, run2)
    determinism = true
  } catch {
    determinism = false
  }

  // 2. 全量≡增量
  const incremental = cast.reduce(stepMission, cloneEmpty(EMPTY_MISSION))
  let fullVsIncremental = false
  try {
    deepStrictEqual(run1, incremental)
    fullVsIncremental = true
  } catch {
    fullVsIncremental = false
  }

  // 3. 重连语义：随机切分点，前半全量 + 后半增量 vs 全量
  let reconnect = false
  if (events.length >= 4) {
    const split = Math.floor(events.length * 0.3) + Math.floor(Math.random() * events.length * 0.4)
    const firstHalf = cast.slice(0, split)
    const secondHalf = cast.slice(split)

    const firstSnapshot = foldMission(firstHalf)
    const reconnected = secondHalf.reduce(stepMission, firstSnapshot)

    try {
      deepStrictEqual(run1, reconnected)
      reconnect = true
    } catch {
      reconnect = false
    }
  } else {
    reconnect = true // 事件太少，跳过重连测试（视为通过）
  }

  // 收集事件类型
  const eventTypes = [...new Set(events.map(e => e.type))]

  return { sessionId, eventCount: events.length, determinism, fullVsIncremental, reconnect, eventTypes }
}

function cloneEmpty(s: MissionSnapshot): MissionSnapshot {
  return { ...s, pendingDecisions: [], council: undefined, goal: undefined, team: undefined }
}

// ── 缺口报告 ──────────────────────────────────────────

const TARGET_EVENT_TYPES = [
  'goal_state',
  'delegation',
  'tool_result',
  'unattended_halt',
  'tool_delegate',
  'plan_submitted',
  'plan_mode',
  'approval_required',
  'approval_resolved',
  'done',
  'error',
] as const

function buildGapReport(results: ValidationResult[]): GapReport {
  const presence: Record<string, number> = {}
  for (const t of TARGET_EVENT_TYPES) {
    presence[t] = 0
  }

  for (const r of results) {
    const seen = new Set(r.eventTypes)
    for (const t of TARGET_EVENT_TYPES) {
      if (seen.has(t)) presence[t]!++
    }
  }

  const missing = TARGET_EVENT_TYPES.filter(t => presence[t] === 0)
  return { presence, missing }
}

// ── 启动 ──────────────────────────────────────────────

main()
