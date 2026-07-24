import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolCardLive, formatToolCard, isToolCardTruncated } from '../tool-card.js'
import { getTheme } from '../../theme.js'
import { buildFileDiff } from '../../../tools/edit-diff.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatToolCardLive', async () => {
  it('returns a fixed height even without output tail', async () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      outputTail: '',
      columns: 80,
      tailLines: 3,
    }, theme)
    assert.equal(lines.length, 1 + 3, 'header + fixed tail rows')
  })

  it('pads empty tail rows when output is short', async () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'echo hi' },
      outputTail: 'hello',
      columns: 80,
      tailLines: 3,
    }, theme)
    assert.equal(lines.length, 1 + 3, 'fixed height')
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('hello')), 'content visible')
  })

  it('shows only the last tailLines of output', async () => {
    const output = 'line1\nline2\nline3\nline4'
    const lines = formatToolCardLive({
      toolName: 'bash',
      outputTail: output,
      columns: 80,
      tailLines: 2,
    }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('line4')), 'last line visible')
    assert.ok(!plain.some(l => l.includes('line1')), 'first line dropped')
  })

  it('renders a spinner bullet when tick is provided', async () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'sleep 1' },
      columns: 80,
      tick: 1,
      tailLines: 3,
    }, theme)
    const header = stripAnsi(lines[0]!)
    assert.ok(header.includes('Run(sleep 1)') || header.includes('bash'), 'title present')
    assert.equal(lines.length, 1 + 3, 'fixed height with spinner')
  })
})

describe('formatToolCard — inline edit diff (write family + isDiffContent)', async () => {
  it('colors an edit_file uiContent diff and shows the +N −M summary', async () => {
    const diff = await buildFileDiff('src/foo.ts', 'alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\n')
    const lines = formatToolCard({
      toolName: 'edit_file',
      content: diff,
      toolInput: { file_path: 'src/foo.ts' },
      elapsedMs: 12,
    }, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.match(plain, /diff: \+1 −1/, 'diff stat summary present')
    assert.ok(plain.includes('-beta'), 'removal line rendered')
    assert.ok(plain.includes('+BETA'), 'addition line rendered')
  })

  it('routes apply_patch output through the diff renderer', async () => {
    const diff = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n'
    const lines = formatToolCard({
      toolName: 'apply_patch',
      content: diff,
      elapsedMs: 5,
    }, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.match(plain, /diff: \+1 −1/)
  })
})

describe('formatToolCard — diff 内联阈值 (adds+dels ≤ 10)', () => {
  it('renders inline diff when adds+dels = 10', () => {
    // 构造恰好 10 行修改 (5 adds + 5 dels)
    const hunks = '@@ -1,5 +1,5 @@'
    const dels = ['-a', '-b', '-c', '-d', '-e']
    const adds = ['+A', '+B', '+C', '+D', '+E']
    const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', hunks, ...dels, ...adds].join('\n')
    const lines = formatToolCard({ toolName: 'edit_file', content: diff }, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.match(plain, /diff: \+5 −5/, 'diff stat should be present')
    assert.ok(plain.includes('-a'), 'removal lines rendered inline')
    assert.ok(plain.includes('+A'), 'addition lines rendered inline')
  })

  it('renders summary when adds+dels > 10', () => {
    // 构造 12 行修改 (6 adds + 6 dels)
    const hunks = '@@ -1,6 +1,6 @@'
    const dels = ['-a', '-b', '-c', '-d', '-e', '-f']
    const adds = ['+A', '+B', '+C', '+D', '+E', '+F']
    const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', hunks, ...dels, ...adds].join('\n')
    const lines = formatToolCard({ toolName: 'edit_file', content: diff }, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.match(plain, /1 处修改/, 'summary with hunk count')
    assert.match(plain, /\+6 −6/, 'summary with line counts')
    assert.ok(!plain.includes('-a'), 'removal lines NOT rendered inline')
    assert.ok(!plain.includes('+A'), 'addition lines NOT rendered inline')
    assert.match(plain, /Ctrl\+O/, 'expand hint present')
  })

  it('isToolCardTruncated returns false for ≤10 changes', () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-a\n-b\n-c\n+A\n+B\n+C\n'
    assert.equal(isToolCardTruncated({ toolName: 'edit_file', content: diff }), false)
  })

  it('isToolCardTruncated returns true for >10 changes', () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,6 +1,6 @@\n-a\n-b\n-c\n-d\n-e\n-f\n+A\n+B\n+C\n+D\n+E\n+F\n'
    assert.equal(isToolCardTruncated({ toolName: 'edit_file', content: diff }), true)
  })
})
