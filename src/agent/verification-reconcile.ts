/**
 * 验证命令对账 — 计划声明的验证命令 vs 本轮实际运行记录逐条核销。
 *
 * 事故背景（2026-07-23 council-panel 帧交付）：worker 新建的测试套件死循环
 * 挂死，交付报告只报了跑通的套件（"35/35 全绿"数字真实，遗漏才是手法），
 * 两个计划声明的验证命令从未跑完却穿过了交付。诚实门禁覆盖"虚报"，
 * 不覆盖"漏报"——本模块把对账做成机械核销：每条声明命令给出
 * passed / failed / blocked / not_run 四态，缺态即披露。
 *
 * Advisory 层：与回归清单（层3）、义务账（Norns）同列，绝不阻断交付。
 */
import type { TaskLedgerEvent } from './task-ledger.js'
import type { UnifiedPlan } from './unified-plan.js'

export interface VerificationReconcileItem {
  command: string
  status: 'passed' | 'failed' | 'blocked' | 'not_run'
  /** 人读细节：pass/fail 计数、blockedReason 等。 */
  detail?: string
}

/** 收集计划中声明的验证命令（跨任务去重，保序）。 */
export function declaredVerificationCommands(plan: Pick<UnifiedPlan, 'tasks'>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const task of plan.tasks) {
    for (const cmd of task.verification ?? []) {
      const key = normalize(cmd)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(cmd.trim())
    }
  }
  return out
}

function normalize(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ')
}

/** 宽松匹配：声明命令与实跑命令（含 resolvedCommand）互为包含即算命中。
 *  声明 `npx tsx --test src/foo.test.ts`、实跑 `npx tsx --test src/foo.test.ts src/bar.test.ts`
 *  这类扩集运行也应记入声明命令的账。 */
function matches(declared: string, event: TaskLedgerEvent): boolean {
  const d = normalize(declared)
  const candidates = [event.command, event.meta?.resolvedCommand]
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .map(normalize)
  return candidates.some(c => c.includes(d) || d.includes(c))
}

/**
 * 对账：每条声明命令取**最后一条**匹配记录的状态（后跑覆盖先跑），
 * 无匹配记录 → not_run。
 */
export function reconcileVerificationCommands(
  declared: string[],
  ran: ReadonlyArray<TaskLedgerEvent>,
): VerificationReconcileItem[] {
  return declared.map((command) => {
    let last: TaskLedgerEvent | undefined
    for (const ev of ran) {
      if (matches(command, ev)) last = ev
    }
    if (!last || !last.status) return { command, status: 'not_run' }
    const meta = last.meta ?? {}
    let detail: string | undefined
    if (last.status === 'blocked') {
      detail = typeof meta.blockedReason === 'string' ? meta.blockedReason : undefined
    } else {
      const passed = typeof meta.passed === 'number' ? meta.passed : undefined
      const failed = typeof meta.failed === 'number' ? meta.failed : undefined
      if (passed !== undefined && failed !== undefined) detail = `${passed} pass ${failed} fail`
    }
    return { command, status: last.status, ...(detail ? { detail } : {}) }
  })
}

/** 渲染对账报告。全绿时单行带过；有缺口时逐条列出并给硬提示。 */
export function formatVerificationReconcileReport(items: VerificationReconcileItem[]): string[] {
  if (items.length === 0) return []
  const unsettled = items.filter(i => i.status !== 'passed')
  if (unsettled.length === 0) {
    return ['', `✓ 验证命令对账：计划声明 ${items.length} 条，全部有通过记录。`]
  }
  const lines = ['', `── 验证命令对账（计划声明 ${items.length} 条，${unsettled.length} 条未核销）──`]
  for (const item of items) {
    const mark = item.status === 'passed' ? '✓'
      : item.status === 'failed' ? '✗'
        : item.status === 'blocked' ? '⏱'
          : '∅'
    const label = item.status === 'not_run' ? '无运行记录'
      : item.status === 'blocked' ? `blocked${item.detail ? `（${item.detail}）` : ''}——跑了但没跑完 = 未验证`
        : `${item.status}${item.detail ? `（${item.detail}）` : ''}`
    lines.push(`  ${mark} ${item.command} — ${label}`)
  }
  lines.push('  → 对账不平不阻断交付，但交付报告必须逐条披露上述状态——只报跑通的套件、对没跑完的沉默，与虚报同罪。')
  lines.push('  → blocked(timeout) 的套件若覆盖本轮新建/修改的代码，优先怀疑代码死循环而非机器慢。')
  return lines
}
