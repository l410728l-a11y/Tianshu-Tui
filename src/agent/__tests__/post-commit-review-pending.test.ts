import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  addPendingReviewFiles,
  consumePendingReview,
  peekPendingReview,
  __resetPostCommitReviewPending,
} from '../post-commit-review-pending.js'

describe('post-commit-review-pending', () => {
  beforeEach(() => {
    __resetPostCommitReviewPending()
  })

  it('accumulates files as a deduped union across commits', () => {
    addPendingReviewFiles('s1', ['src/a.ts', 'src/b.ts'])
    const scope = addPendingReviewFiles('s1', ['src/b.ts', 'src/c.ts'])

    assert.equal(scope.commits, 2)
    assert.deepEqual([...scope.files].sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts'])
    const peeked = peekPendingReview('s1')
    assert.equal(peeked?.commits, 2)
    assert.equal(peeked?.files.size, 3)
  })

  it('escalate flag sticks once any commit escalates', () => {
    addPendingReviewFiles('s1', ['src/a.ts'])
    const scope = addPendingReviewFiles('s1', ['src/b.ts'], { escalate: true })
    assert.equal(scope.escalate, true)
    const scope2 = addPendingReviewFiles('s1', ['src/c.ts'])
    assert.equal(scope2.escalate, true, 'escalate must survive later non-escalated commits')
  })

  it('consume returns the scope and clears it', () => {
    addPendingReviewFiles('s1', ['src/a.ts'], { escalate: true })
    const consumed = consumePendingReview('s1')
    assert.equal(consumed?.commits, 1)
    assert.equal(consumed?.escalate, true)
    assert.equal(peekPendingReview('s1'), null)
    assert.equal(consumePendingReview('s1'), null, 'double consume must be a no-op')
  })

  it('scopes are isolated per session (sidecar multi-session)', () => {
    addPendingReviewFiles('s1', ['src/a.ts'])
    addPendingReviewFiles('s2', ['src/x.ts', 'src/y.ts'])

    assert.equal(peekPendingReview('s1')?.files.size, 1)
    assert.equal(peekPendingReview('s2')?.files.size, 2)
    consumePendingReview('s1')
    assert.equal(peekPendingReview('s1'), null)
    assert.equal(peekPendingReview('s2')?.commits, 1, 's2 scope untouched by s1 consume')
  })

  it('undefined sessionId falls back to a shared key without crashing', () => {
    addPendingReviewFiles(undefined, ['src/a.ts'])
    const scope = peekPendingReview(undefined)
    assert.equal(scope?.commits, 1)
    assert.equal(scope?.files.has('src/a.ts'), true)
  })

  it('peek does not consume', () => {
    addPendingReviewFiles('s1', ['src/a.ts'])
    peekPendingReview('s1')
    peekPendingReview('s1')
    assert.equal(peekPendingReview('s1')?.commits, 1)
  })
})
