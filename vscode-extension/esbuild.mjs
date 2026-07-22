// 双 bundle：扩展宿主（node/cjs）+ webview 座舱（browser/iife）。
import esbuild from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const extensionCfg = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
  define: { RUNTIME_VERSION: JSON.stringify(pkg.version) },
}

/** @type {import('esbuild').BuildOptions} */
const webviewCfg = {
  entryPoints: ['webview-ui/src/main.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
}

if (watch) {
  const ctxs = await Promise.all([esbuild.context(extensionCfg), esbuild.context(webviewCfg)])
  await Promise.all(ctxs.map((c) => c.watch()))
} else {
  await Promise.all([esbuild.build(extensionCfg), esbuild.build(webviewCfg)])
}
