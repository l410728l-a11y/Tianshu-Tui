/**
 * failure-taxonomy — 开案信号 → 恢复路由分类器（PAL 第五波）。
 *
 * 把 case-open-signals 的七类聚合信号映射到统一的恢复阶梯（StallClass +
 * RecoveryRoute），供 CV3-open 骨架和四个专用声源消费。
 *
 * 设计约束（继承 case-open-signals 的纪律）：
 * - 输出确定性：相同输入产生相同输出。debugLog 仅观测、不影响返回值。
 * - 只分类、不发声：绝不 import AdvisoryBus，不 submit。
 * - 无默认兜底类：每类 source 都有显式 StallClass 映射。
 */

import type { CaseOpenSignal } from './case-open-signals.js'
import { debugLog } from '../utils/debug.js'

/** 卡死模式——行为级分类，区别于 failure-classifier 的工具级 FailureClass。 */
export type StallClass =
  | 'edit-stuck'          // edit-failure: 编辑动作本身失败
  | 'verify-loop'         // dead-end-file: 编辑成功但验证循环失败
  | 'regression-loop'     // regression-bisect: 回归语义诊断空转
  | 'strategy-stall'      // convergence-abort:score: 策略失效
  | 'no-tool-stall'       // convergence-abort:no-tool: 工具权限/定义不匹配
  | 'plan-blocked'        // plan trace 连续 blocked
  | 'gate-failed'         // wave-gate 未通过
  | 'obligation-blocked'  // high-risk 义务受阻

/** 恢复路由——分类器输出，供声源文案消费。 */
export interface RecoveryRoute {
  stallClass: StallClass
  /** 成本序恢复阶梯，用 PAL 诊断阶梯语汇。 */
  ladder: readonly string[]
  /** 升级出口：继续专用建议 / attack_case 开案 / 问用户
   *  当前未被消费（预留接口）；CV3-open 通过 annotation 和 ladder[0] 使用。 */
  escalation: 'specialized' | 'attack-case' | 'ask-user'
}

/**
 * convergence-abort ref 到子类映射。
 * ref 形如 `convergence-abort:score` 或 `convergence-abort:no-tool`，
 * cause 后缀由 convergence-detector 生成。
 */
function convergenceAbortCause(ref: string): 'score' | 'no-tool' | undefined {
  if (ref === 'convergence-abort:no-tool' || ref.includes(':no-tool')) return 'no-tool'
  if (ref === 'convergence-abort:score' || ref.startsWith('convergence-abort:')) return 'score'
  return undefined
}

/**
 * 开案信号 → 恢复路由分类。
 *
 * 映射表（source + convergence 子类 → StallClass）：
 * | source               | anchor ref            | stallClass          | ladder                                    | escalation    |
 * |----------------------|-----------------------|---------------------|-------------------------------------------|---------------|
 * | edit-failure         | —                     | edit-stuck          | 先 read_file 探针 → 微探针 → 基线对照       | specialized   |
 * | dead-end-file        | —                     | verify-loop         | 读实现 → 微探针 → 复现                      | attack-case   |
 * | regression-bisect    | —                     | regression-loop     | 读实现 → 基线对照 → 复现                    | attack-case   |
 * | convergence-abort    | :score                | strategy-stall      | 换方向 → 读实现 → 微探针                    | attack-case   |
 * | convergence-abort    | :no-tool              | no-tool-stall       | 查工具权限 → 读实现                          | ask-user      |
 * | plan-blocked         | —                     | plan-blocked        | 读实现 → 微探针                             | attack-case   |
 * | wave-gate            | —                     | gate-failed         | 读实现 → 复现                               | specialized   |
 * | obligation-high      | —                     | obligation-blocked  | 读实现 → 复现 → 基线对照                    | attack-case   |
 */
export function classifyFailureSignal(signal: CaseOpenSignal): RecoveryRoute {
  // convergence-abort 需要按 ref 区分 cause 子类
  if (signal.source === 'convergence-abort') {
    const cause = convergenceAbortCause(signal.anchor.ref)
    const route = cause === 'no-tool'
      ? STALL_ROUTE_TABLE['no-tool-stall']
      : STALL_ROUTE_TABLE['strategy-stall']
    debugLog(`[failure-route] class=${route.stallClass} source=${signal.source} cause=${cause ?? 'score'}`)
    return route
  }
  // 其余 source → StallClass 一一映射
  const key = SOURCE_TO_STALL[signal.source]
  const route = STALL_ROUTE_TABLE[key]
  debugLog(`[failure-route] class=${route.stallClass} source=${signal.source}`)
  return route
}

/** CaseOpenSignalSource → StallClass 映射（convergence-abort 走 cause 分支）。 */
const SOURCE_TO_STALL: Record<CaseOpenSignal['source'], StallClass> = {
  'edit-failure': 'edit-stuck',
  'dead-end-file': 'verify-loop',
  'regression-bisect': 'regression-loop',
  'convergence-abort': 'strategy-stall', // fallback；实际由 cause 分支决定
  'plan-blocked': 'plan-blocked',
  'wave-gate': 'gate-failed',
  'obligation-high': 'obligation-blocked',
}

/**
 * 恢复路由 → 文案标注。
 *
 * 输出字节确定、不包含随机/时间戳，长度上限 80 字符。
 * 格式：`[恢复: 阶梯1→阶梯2→...]`
 *
 * 输出举例：
 * - edit-stuck: `[恢复: 先 read_file 探针→微探针→基线对照]`
 * - no-tool-stall: `[恢复: 查工具权限→读实现]`
 */
export function renderRouteAnnotation(route: RecoveryRoute): string {
  const ladderText = route.ladder.join('→')
  // 截断到 75 字符留 ] 的余量
  const truncated = ladderText.length > 73
    ? ladderText.slice(0, 70) + '…'
    : ladderText
  return `[恢复: ${truncated}]`
}

/**
 * StallClass → RecoveryRoute 路由表（当前唯一权威源）。
 *
 * 所有专用声源文案标注必须从本表取值，禁止手写字面量。
 * classifyFailureSignal 内部也从同一数据构造返回值。
 */
export const STALL_ROUTE_TABLE: Record<StallClass, RecoveryRoute> = {
  'edit-stuck': {
    stallClass: 'edit-stuck',
    ladder: ['先 read_file 探针', '微探针', '基线对照'],
    escalation: 'specialized',
  },
  'verify-loop': {
    stallClass: 'verify-loop',
    ladder: ['读实现', '微探针', '复现'],
    escalation: 'attack-case',
  },
  'regression-loop': {
    stallClass: 'regression-loop',
    ladder: ['读实现', '基线对照', '复现'],
    escalation: 'attack-case',
  },
  'strategy-stall': {
    stallClass: 'strategy-stall',
    ladder: ['换方向', '读实现', '微探针'],
    escalation: 'attack-case',
  },
  'no-tool-stall': {
    stallClass: 'no-tool-stall',
    ladder: ['查工具权限', '读实现'],
    escalation: 'ask-user',
  },
  'plan-blocked': {
    stallClass: 'plan-blocked',
    ladder: ['读实现', '微探针'],
    escalation: 'attack-case',
  },
  'gate-failed': {
    stallClass: 'gate-failed',
    ladder: ['读实现', '复现'],
    escalation: 'specialized',
  },
  'obligation-blocked': {
    stallClass: 'obligation-blocked',
    ladder: ['读实现', '复现', '基线对照'],
    escalation: 'attack-case',
  },
}
