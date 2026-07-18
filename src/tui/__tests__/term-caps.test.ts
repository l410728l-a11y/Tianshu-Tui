import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  isLegacyWindowsConsole,
  isCjkLocale,
  useAsciiGlyphs,
  resetTermCapsCache,
} from '../term-caps.js'

afterEach(() => {
  resetTermCapsCache()
})

describe('isLegacyWindowsConsole', () => {
  it('win32 且无现代终端标记 → true（PowerShell/cmd 直启 conhost）', () => {
    assert.equal(isLegacyWindowsConsole({}, 'win32'), true)
  })

  it('Windows Terminal（WT_SESSION）→ false', () => {
    assert.equal(isLegacyWindowsConsole({ WT_SESSION: 'abc' }, 'win32'), false)
  })

  it('VS Code 集成终端（TERM_PROGRAM）→ false', () => {
    assert.equal(isLegacyWindowsConsole({ TERM_PROGRAM: 'vscode' }, 'win32'), false)
  })

  it('ConEmu（ConEmuANSI）→ false', () => {
    assert.equal(isLegacyWindowsConsole({ ConEmuANSI: 'ON' }, 'win32'), false)
  })

  it('mintty/Git Bash（TERM 已设）→ false', () => {
    assert.equal(isLegacyWindowsConsole({ TERM: 'xterm-256color' }, 'win32'), false)
  })

  it('非 win32 平台 → 恒 false', () => {
    assert.equal(isLegacyWindowsConsole({}, 'darwin'), false)
    assert.equal(isLegacyWindowsConsole({}, 'linux'), false)
  })
})

describe('isCjkLocale', () => {
  it('LANG=zh_CN.UTF-8 → true', () => {
    assert.equal(isCjkLocale({ LANG: 'zh_CN.UTF-8' }), true)
  })

  it('LC_ALL=ja_JP 优先命中 → true', () => {
    assert.equal(isCjkLocale({ LC_ALL: 'ja_JP', LANG: 'en_US.UTF-8' }), true)
  })

  it('LC_CTYPE=ko_KR → true', () => {
    assert.equal(isCjkLocale({ LC_CTYPE: 'ko_KR.UTF-8' }), true)
  })
})

describe('useAsciiGlyphs', () => {
  it('RIVET_ASCII_UI=1 显式开启 → true（不受缓存影响）', () => {
    assert.equal(useAsciiGlyphs({ RIVET_ASCII_UI: '1' }), true)
  })

  it('RIVET_ASCII_UI=0 显式关闭 → false（覆盖自动探测）', () => {
    assert.equal(useAsciiGlyphs({ RIVET_ASCII_UI: '0' }), false)
  })
})
