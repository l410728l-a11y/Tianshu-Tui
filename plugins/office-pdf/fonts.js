// CJK font resolution for pdfkit: pdfkit's built-in Helvetica/Courier have no
// CJK glyphs, so when content contains CJK characters we locate a usable
// system font and register it explicitly (TTC files need a postscript name).

import { existsSync } from 'node:fs'

const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/

export function containsCjk(text) {
  return typeof text === 'string' && CJK_RE.test(text)
}

// Ordered per-platform candidates. `names` are preferred postscript names
// inside a TTC collection; plain .ttf/.otf entries use an empty list (pdfkit
// loads them by path alone). `headingNames` optionally picks a heavier cut
// for headings, falling back to the body name.
const CJK_FONT_CANDIDATES = [
  // macOS
  { path: '/System/Library/Fonts/PingFang.ttc', names: ['PingFangSC-Regular'] },
  { path: '/System/Library/Fonts/Hiragino Sans GB.ttc', names: ['HiraginoSansGB-W3'], headingNames: ['HiraginoSansGB-W6'] },
  { path: '/System/Library/Fonts/STHeiti Light.ttc', names: ['STHeitiSC-Light'] },
  // Windows
  { path: 'C:\\Windows\\Fonts\\msyh.ttc', names: ['MicrosoftYaHei'] },
  { path: 'C:\\Windows\\Fonts\\simhei.ttf', names: [] },
  { path: 'C:\\Windows\\Fonts\\simsun.ttc', names: ['SimSun'] },
  // Linux
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', names: ['NotoSansCJKsc-Regular', 'NotoSansCJK-Regular'] },
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf', names: [] },
  { path: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', names: ['WenQuanYiZenHei'] },
]

function pickName(fonts, preferred) {
  for (const n of preferred || []) {
    if (fonts.some(f => f.postscriptName === n)) return n
  }
  return null
}

/**
 * Resolve the first usable CJK font.
 * Returns { path, name, headingName } (name/headingName null for plain
 * ttf/otf), or null when no candidate exists / is loadable.
 */
export async function resolveCjkFont() {
  let fontkit = null
  try {
    fontkit = (await import('fontkit')).default
  } catch {
    // fontkit ships with pdfkit; without it we can only use plain ttf/otf
  }

  for (const cand of CJK_FONT_CANDIDATES) {
    if (!existsSync(cand.path)) continue
    if (cand.names.length === 0) {
      return { path: cand.path, name: null, headingName: null }
    }
    if (!fontkit) continue
    try {
      const opened = fontkit.openSync(cand.path)
      const fonts = opened.fonts || [opened]
      const name = pickName(fonts, cand.names) || fonts[0].postscriptName
      if (!name) continue
      const headingName = pickName(fonts, cand.headingNames) || name
      return { path: cand.path, name, headingName }
    } catch {
      continue
    }
  }
  return null
}
