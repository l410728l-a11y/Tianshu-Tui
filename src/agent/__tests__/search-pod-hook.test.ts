/**
 * search-pod-hook（风暴遗产回收 W-B）— 检索 POD shadow 分类器反证测试。
 *
 * 反证清单：判据确定性（同输入同分类）；ast_grep 空结果不误报高检出力；
 * 非空高分结果不记录；非检索工具/失败调用不记录；hook 零 advisory 纪律
 * 由实现保证（deps 只有 record，无 advisoryBus 可用）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SEMANTIC_LOW_SCORE_THRESHOLD,
  classifySearchPod,
  createSearchPodHook,
  type SearchPodRow,
} from '../hooks/search-pod-hook.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'

function ev(partial: Partial<RuntimeToolEvent> & { name: string }): RuntimeToolEvent {
  return { success: true, ...partial }
}

describe('classifySearchPod — grep', () => {
  it('字面量 pattern + 全库搜 + 空结果 → high-pod（可信排除）', () => {
    const row = classifySearchPod(ev({
      name: 'grep', resultContent: 'No matches found.',
      input: { pattern: 'FrobnicateWidget' },
    }))
    assert.deepEqual(row, { event: 'search-pod', tool: 'grep', queryClass: 'high-pod', emptyResult: true })
  })

  it('含正则元字符 → low-pod；限定 path/glob → low-pod', () => {
    const regex = classifySearchPod(ev({
      name: 'grep', resultContent: 'No matches found.',
      input: { pattern: 'foo.*bar' },
    }))
    assert.equal(regex?.queryClass, 'low-pod')
    const scoped = classifySearchPod(ev({
      name: 'grep', resultContent: 'No matches found.',
      input: { pattern: 'plainLiteral', path: 'src/agent' },
    }))
    assert.equal(scoped?.queryClass, 'low-pod')
  })

  it('literal: true 显式声明时元字符不降级', () => {
    const row = classifySearchPod(ev({
      name: 'grep', resultContent: 'No matches found.',
      input: { pattern: 'a.b(c)', literal: true },
    }))
    assert.equal(row?.queryClass, 'high-pod')
  })

  it('反证：有结果不记录；失败/isError 不记录', () => {
    assert.equal(classifySearchPod(ev({
      name: 'grep', resultContent: 'src/a.ts:1: hit', input: { pattern: 'x' },
    })), null)
    assert.equal(classifySearchPod(ev({
      name: 'grep', success: false, resultContent: 'No matches found.', input: { pattern: 'x' },
    })), null)
    assert.equal(classifySearchPod(ev({
      name: 'grep', isError: true, resultContent: 'No matches found.', input: { pattern: 'x' },
    })), null)
  })
})

describe('classifySearchPod — glob / ast_grep', () => {
  it('glob 简单文件名 + 全库 → high-pod；限定 path 或含目录段 → low-pod', () => {
    const simple = classifySearchPod(ev({
      name: 'glob', resultContent: 'No files found matching pattern',
      input: { pattern: '**/config.yaml' },
    }))
    assert.equal(simple?.queryClass, 'high-pod')
    const scoped = classifySearchPod(ev({
      name: 'glob', resultContent: 'No files found matching pattern',
      input: { pattern: '*.ts', path: 'src/tui' },
    }))
    assert.equal(scoped?.queryClass, 'low-pod')
    const nested = classifySearchPod(ev({
      name: 'glob', resultContent: 'No files found matching pattern',
      input: { pattern: 'src/**/hooks/*.ts' },
    }))
    assert.equal(nested?.queryClass, 'low-pod')
  })

  it('ast_grep 空结果一律 low-pod（形状敏感，不存在可信排除）', () => {
    const row = classifySearchPod(ev({
      name: 'ast_grep', resultContent: '0 match(es) in 214 file(s)',
      input: { pattern: 'function $NAME($$ARGS)' },
    }))
    assert.deepEqual(row, { event: 'search-pod', tool: 'ast_grep', queryClass: 'low-pod', emptyResult: true })
    assert.equal(classifySearchPod(ev({
      name: 'ast_grep', resultContent: '3 match(es) in 214 file(s)\n\n…',
    })), null)
  })
})

describe('classifySearchPod — semantic_search 三级判据', () => {
  it('绝对空 → low-pod 记录（embedding 召回有限，空 ≠ 全库无相关）', () => {
    const row = classifySearchPod(ev({
      name: 'semantic_search', resultContent: 'Index refreshed. No matches for: auth token rotation',
    }))
    assert.deepEqual(row, { event: 'search-pod', tool: 'semantic_search', queryClass: 'low-pod', emptyResult: true })
  })

  it(`top score < ${SEMANTIC_LOW_SCORE_THRESHOLD} → low-pod 带分数；高分不记录`, () => {
    const low = classifySearchPod(ev({
      name: 'semantic_search',
      resultContent: 'src/a.ts:1-9 (score 0.212)\nsome snippet',
    }))
    assert.equal(low?.queryClass, 'low-pod')
    assert.equal(low?.emptyResult, false)
    assert.equal(low?.topScore, 0.212)
    assert.equal(classifySearchPod(ev({
      name: 'semantic_search',
      resultContent: 'src/a.ts:1-9 (score 0.841)\nsome snippet',
    })), null)
  })
})

describe('classifySearchPod — 纪律', () => {
  it('非检索工具不记录', () => {
    assert.equal(classifySearchPod(ev({ name: 'read_file', resultContent: 'No matches found.' })), null)
    assert.equal(classifySearchPod(ev({ name: 'bash', resultContent: 'No files found matching pattern' })), null)
  })

  it('确定性：同输入两次分类 deepEqual', () => {
    const input = ev({ name: 'grep', resultContent: 'No matches found.', input: { pattern: 'x.y', glob: '*.ts' } })
    assert.deepEqual(classifySearchPod(input), classifySearchPod(input))
  })
})

describe('createSearchPodHook', () => {
  it('可记录事件落行（带 turn）；不可记录事件零调用', () => {
    const rows: SearchPodRow[] = []
    const hook = createSearchPodHook({ record: r => rows.push(r) })
    const ctx = { snapshot: { turn: 7 } } as unknown as RuntimeHookContext
    hook.run(ctx, ev({ name: 'grep', resultContent: 'No matches found.', input: { pattern: 'PlainNeedle' } }))
    hook.run(ctx, ev({ name: 'grep', resultContent: 'src/a.ts:1: hit', input: { pattern: 'PlainNeedle' } }))
    hook.run(ctx, ev({ name: 'edit_file', resultContent: 'ok' }))
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.turn, 7)
    assert.equal(rows[0]!.queryClass, 'high-pod')
  })
})
