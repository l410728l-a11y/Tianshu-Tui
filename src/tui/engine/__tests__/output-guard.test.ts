import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { installOutputGuard, type OutputGuard } from '../output-guard.js'

// 注意：guard 会 patch 全局 process.stderr.write——每个用例必须 dispose，
// afterEach 兜底，防止泄漏影响同进程其他断言。

describe('OutputGuard', () => {
  let guard: OutputGuard | null = null
  afterEach(() => {
    guard?.dispose()
    guard = null
  })

  it('完整行被 sanitize 后路由给 onText，不直写 stderr', () => {
    const received: string[] = []
    guard = installOutputGuard((t) => { received.push(t) })
    process.stderr.write('hello world\n')
    assert.deepEqual(received, ['hello world'])
  })

  it('按行缓冲：半行先不发射，补全后合并为一行', () => {
    const received: string[] = []
    guard = installOutputGuard((t) => { received.push(t) })
    process.stderr.write('abc')
    assert.equal(received.length, 0)
    process.stderr.write('def\n')
    assert.deepEqual(received, ['abcdef'])
  })

  it('ANSI/控制字符被剥离（CSI、OSC、控制码）', () => {
    const received: string[] = []
    guard = installOutputGuard((t) => { received.push(t) })
    process.stderr.write('\x1B[31mred text\x1B[0m\x1B]8;;http://x\x07link\x07\x01\n')
    assert.deepEqual(received, ['red textlink'])
  })

  it('多行一次写入逐行发射；空行不发射', () => {
    const received: string[] = []
    guard = installOutputGuard((t) => { received.push(t) })
    process.stderr.write('one\n\n  \ntwo\n')
    assert.deepEqual(received, ['one', 'two'])
  })

  it('dispose 恢复原始 write，缓冲残尾原样补写', () => {
    const received: string[] = []
    guard = installOutputGuard((t) => { received.push(t) })
    process.stderr.write('tail-no-newline')
    const original = (guard as unknown as { dispose(): void })
    void original
    guard.dispose()
    guard = null
    // dispose 后 stderr.write 已恢复：再写不会进 onText
    process.stderr.write('after\n')
    assert.deepEqual(received, [])
  })

  it('重复安装幂等：返回同一实例，二次安装不换回调', () => {
    const first: string[] = []
    const second: string[] = []
    guard = installOutputGuard((t) => { first.push(t) })
    const guard2 = installOutputGuard((t) => { second.push(t) })
    assert.equal(guard, guard2)
    process.stderr.write('x\n')
    assert.deepEqual(first, ['x'])
    assert.deepEqual(second, [])
  })
})
