/**
 * Tests for anti-interactive env injection in getResolvedEnv().
 *
 * Ensures all spawn points that go through getResolvedEnv() inherit
 * PAGER=cat / GIT_TERMINAL_PROMPT=0 / GPG_TTY="" etc., preventing
 * subprocesses from blocking on interactive prompts.
 */
import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { getResolvedEnv, ANTI_INTERACTIVE_ENV, resetResolvedEnvCache } from '../resolved-env.js'

describe('ANTI_INTERACTIVE_ENV constant', () => {
  test('contains all expected keys', () => {
    assert.equal(ANTI_INTERACTIVE_ENV.PAGER, 'cat')
    assert.equal(ANTI_INTERACTIVE_ENV.GIT_PAGER, 'cat')
    assert.equal(ANTI_INTERACTIVE_ENV.GIT_TERMINAL_PROMPT, '0')
    assert.equal(ANTI_INTERACTIVE_ENV.GPG_TTY, '')
    assert.equal(ANTI_INTERACTIVE_ENV.GIT_EDITOR, 'true')
    assert.equal(ANTI_INTERACTIVE_ENV.GIT_SEQUENCE_EDITOR, 'true')
  })
})

describe('getResolvedEnv anti-interactive injection', () => {
  beforeEach(() => resetResolvedEnvCache())

  test('PAGER is cat', () => {
    const env = getResolvedEnv()
    assert.equal(env.PAGER, 'cat')
  })

  test('GIT_TERMINAL_PROMPT is 0', () => {
    const env = getResolvedEnv()
    assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  })

  test('GPG_TTY is empty string', () => {
    const env = getResolvedEnv()
    assert.equal(env.GPG_TTY, '')
  })

  test('GIT_EDITOR is true (no editor launched)', () => {
    const env = getResolvedEnv()
    assert.equal(env.GIT_EDITOR, 'true')
  })

  test('all ANTI_INTERACTIVE_ENV keys present in resolved env', () => {
    const env = getResolvedEnv()
    for (const [key, val] of Object.entries(ANTI_INTERACTIVE_ENV)) {
      assert.equal(env[key], val, `${key} should be ${val}`)
    }
  })
})
