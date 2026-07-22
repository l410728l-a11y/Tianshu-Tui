import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BM25Index, tokenize } from '../text-index.js'

describe('text-index', () => {
  it('tokenizes code and CJK', () => {
    const tokens = tokenize('function authenticateUser 用户认证')
    assert.ok(tokens.includes('authenticateuser') || tokens.includes('function'))
    // CJK 按 bigram 切分（整段单 token 会让子串查询永远 0 命中）
    assert.deepEqual(tokens.filter(t => /[\u4e00-\u9fff]/.test(t)), ['用户', '户认', '认证'])
  })

  it('CJK 子串查询命中长句语料（2026-07-20 recall 空转回归）', () => {
    const idx = new BM25Index()
    idx.addChunk('k1', 0, 0, '前缀缓存命中率直接影响 token 成本和响应延迟')
    idx.addChunk('k2', 0, 0, 'export function renderButton() {}')

    const hits = idx.search('前缀缓存')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.file, 'k1')
  })

  it('单个 CJK 字符仍可作为 token', () => {
    assert.deepEqual(tokenize('查 bug'), ['查', 'bug'])
  })

  it('ranks relevant chunks higher', () => {
    const idx = new BM25Index()
    idx.addChunk('src/auth.ts', 1, 10, 'export function authenticateUser(token: string) {}')
    idx.addChunk('src/ui.ts', 1, 5, 'export function renderButton() {}')

    const hits = idx.search('user authentication token')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.file, 'src/auth.ts')
  })
})
