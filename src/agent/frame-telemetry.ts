/**
 * P3-D：认知帧全量记录的独立落盘通道（`frames.jsonl`）。
 *
 * 为什么不走 sensorium.jsonl：full frame 记录（facts 全量，可回放）需要
 * **默认落盘**才能积累 P3-D 准入数据（≥15 session / ≥300 条），而
 * sensorium.jsonl 的 full 通道由 RIVET_DEBUG_TELEMETRY opt-in、lite 通道
 * 有 <200B 单行纪律——两边都塞不下。独立文件互不挤占。
 *
 * 开关层级（与 telemetry-writer 的主开关联动）：
 *   RIVET_TELEMETRY_LITE=0  → 全关（frame 是 telemetry 子集，主开关优先）
 *   RIVET_FRAME_TELEMETRY=0 → 只关 frame
 *   默认                     → 开
 *
 * trim 策略（不沿用 telemetry-writer 的按写入次数 TRIM_CHECK_EVERY=200）：
 * frame 是 1 条/turn，且写入计数是实例内存态、session 重启归零——按次数
 * 触发意味着单 session <200 turn 永不 trim，文件实际无上限。这里改为
 * **行数阈值**（首写时读盘初始化计数，之后增量维护）+ **flush 收尾强制
 * 检查一次**。写入经内部 promise 链串行化，追加与 trim 不互相竞态。
 *
 * fail-safe：任何 IO 失败吞掉，绝不阻断 agent loop。
 */

import { join } from 'node:path'
import { getSessionDir } from './session-persist.js'
import type { CognitiveFrameRecord } from './cognitive-frame-replay.js'

export const FRAMES_FILE = 'frames.jsonl'
/** 默认行数上限：约 1KB/条 × 1500 ≈ 1.5MB/session 封顶。 */
export const MAX_FRAME_LINES = 1_500

export interface FrameRecorder {
  /** false 时调用方可跳过记录构建本身（省掉无意义的拷贝）。 */
  readonly enabled: boolean
  write(record: CognitiveFrameRecord): void
  /** 等待在途写入完成，并强制做一次收尾 trim 检查。 */
  flush(): Promise<void>
}

const NOOP_RECORDER: FrameRecorder = {
  enabled: false,
  write() {},
  async flush() {},
}

export interface FrameRecorderOptions {
  /** 测试注入：行数上限（默认 MAX_FRAME_LINES）。 */
  maxLines?: number
}

export function createFrameRecorder(
  cwd: string,
  sessionId?: string,
  options?: FrameRecorderOptions,
): FrameRecorder {
  if (process.env['RIVET_TELEMETRY_LITE'] === '0') return NOOP_RECORDER
  if (process.env['RIVET_FRAME_TELEMETRY'] === '0') return NOOP_RECORDER

  const maxLines = options?.maxLines ?? MAX_FRAME_LINES
  const dir = sessionId ? join(getSessionDir(cwd), sessionId) : join(cwd, '.rivet')
  const path = join(dir, FRAMES_FILE)

  // 首写时从盘上初始化（续写既有 session 的文件），之后增量维护。
  let lineCount: number | null = null
  // 串行队列：追加与 trim 的 read→rewrite 在进程内不竞态。
  let queue: Promise<void> = Promise.resolve()
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task).catch(() => { /* fail-safe：遥测绝不阻断 loop */ })
    return queue
  }

  async function trimIfNeeded(fs: typeof import('node:fs/promises')): Promise<void> {
    try {
      const raw = await fs.readFile(path, 'utf-8')
      const lines = raw.split('\n').filter(l => l.length > 0)
      if (lines.length > maxLines) {
        const tail = lines.slice(lines.length - maxLines)
        await fs.writeFile(path, tail.join('\n') + '\n', 'utf-8')
        lineCount = tail.length
      } else {
        lineCount = lines.length
      }
    } catch { /* 文件不存在/读失败 → 无事可做 */ }
  }

  return {
    enabled: true,
    write(record: CognitiveFrameRecord) {
      const line = JSON.stringify(record)
      enqueue(async () => {
        const fs = await import('node:fs/promises')
        await fs.mkdir(dir, { recursive: true })
        if (lineCount === null) {
          try {
            const raw = await fs.readFile(path, 'utf-8')
            lineCount = raw.split('\n').filter(l => l.length > 0).length
          } catch {
            lineCount = 0
          }
        }
        await fs.appendFile(path, line + '\n', 'utf-8')
        lineCount++
        if (lineCount > maxLines) await trimIfNeeded(fs)
      })
    },
    async flush() {
      await enqueue(async () => {
        // 收尾强制检查：即便阈值路径整个 session 都没触发，也保证退出时有界。
        if (lineCount === null) return // 从未写入 → 无文件可管
        const fs = await import('node:fs/promises')
        await trimIfNeeded(fs)
      })
    },
  }
}
