/**
 * E2 ②级自包含运行时 — 下载 / 校验 / 解压 / 缓存。
 *
 * 触发条件：settings 未指定 cliPath 且 PATH 上无 rivet。
 * 缓存布局：<globalStorage>/runtime/<version>/tianshu-runtime-.../bin/rivet
 * 版本策略：RUNTIME_VERSION 由 esbuild 构建时从 package.json version 注入；
 * 每版本独立缓存目录，升级即自动下载新版本，无需 latest.json 协商。
 *
 * 端点顺序：CF Worker 镜像（境内友好）→ GitHub Release 直连。
 * jsDelivr 不承载 Release 资产（且 50MB 上限），不在链路内。
 *
 * 代理：Node 24 内置 fetch（undici）不会自动读 https_proxy。通过
 * EnvHttpProxyAgent 在企业代理环境下自动接入——零外部依赖。
 */
import * as vscode from 'vscode'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, rmSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import * as os from 'node:os'

/** 内核运行时版本——esbuild 构建时从 package.json version 注入。 */
declare const RUNTIME_VERSION: string | undefined
const _RUNTIME_VERSION: string = typeof RUNTIME_VERSION !== 'undefined' ? RUNTIME_VERSION : '0.0.0'

// ---- 代理（企业网络）--------------------------------------------------------
let _proxyAgent: import('undici').Dispatcher | undefined
let _proxyProbed = false

async function getProxyDispatcher(): Promise<import('undici').Dispatcher | undefined> {
  if (_proxyProbed) return _proxyAgent
  _proxyProbed = true
  try {
    const { EnvHttpProxyAgent } = await import('undici')
    _proxyAgent = new EnvHttpProxyAgent()
  } catch {
    // Node < 24 或 undici 不可用——回退直连（fetch 无代理）
  }
  return _proxyAgent
}

async function fetchWithProxy(url: string, init?: RequestInit): Promise<Response> {
  const dispatcher = await getProxyDispatcher()
  return fetch(url, { ...init, ...(dispatcher ? { dispatcher } : {}) })
}

const ENDPOINTS = [
  'https://update.plotstudio.cn/tianshu/releases/download',
  'https://github.com/huiliyi37/Tianshu-Tui/releases/download',
]

function assetName(): string {
  return `tianshu-runtime-${_RUNTIME_VERSION}-${process.platform}-${process.arch}.tar.gz`
}

function cliRelPath(): string {
  const base = `tianshu-runtime-${_RUNTIME_VERSION}-${process.platform}-${process.arch}`
  return join(base, 'bin', process.platform === 'win32' ? 'rivet.cmd' : 'rivet')
}

/** 已缓存的运行时 CLI 路径；未缓存返回 null。 */
export function cachedRuntimeCli(storageDir: string): string | null {
  const cli = join(storageDir, 'runtime', _RUNTIME_VERSION, cliRelPath())
  return existsSync(cli) ? cli : null
}

/** PATH 上是否有 rivet（which/where 探测，比 spawn-ENOENT 提前拿到答案）。 */
export function rivetOnPath(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(os.platform() === 'win32' ? 'where' : 'which', ['rivet'], {
      stdio: 'ignore',
      shell: os.platform() === 'win32',
    })
    probe.on('close', (code) => resolve(code === 0))
    probe.on('error', () => resolve(false))
  })
}

async function downloadTo(
  url: string,
  dest: string,
  onProgress: (pct: number | null) => void,
): Promise<void> {
  const res = await fetchWithProxy(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${url}`)
  const total = Number(res.headers.get('content-length') || 0)
  const file = createWriteStream(dest)
  let received = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      onProgress(total > 0 ? Math.round((received / total) * 100) : null)
      await new Promise<void>((resolve, reject) => {
        file.write(value, (err) => (err ? reject(err) : resolve()))
      })
    }
  } finally {
    await new Promise<void>((resolve) => file.end(() => resolve()))
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetchWithProxy(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return await res.text()
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function untar(archive: string, destDir: string): Promise<void> {
  // macOS / Linux / Windows 10+ 都自带 tar
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', destDir], { stdio: 'ignore' })
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))))
    child.on('error', reject)
  })
}

/**
 * 确保自包含运行时可用，返回 CLI 路径。已缓存直接返回；否则带进度下载。
 * 三端点顺序尝试；全部失败抛错（调用方降级提示手动安装）。
 */
export async function ensureRuntime(storageDir: string): Promise<string> {
  const cached = cachedRuntimeCli(storageDir)
  if (cached) return cached

  const versionDir = join(storageDir, 'runtime', _RUNTIME_VERSION)
  const asset = assetName()

  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '下载天枢运行时…',
      cancellable: false,
    },
    async (progress) => {
      mkdirSync(versionDir, { recursive: true })
      const archivePath = join(versionDir, asset)
      let lastErr: Error | undefined
      for (const base of ENDPOINTS) {
        const url = `${base}/runtime-v${_RUNTIME_VERSION}/${asset}`
        try {
          let lastPct = 0
          await downloadTo(url, archivePath, (pct) => {
            if (pct !== null && pct > lastPct) {
              progress.report({ increment: pct - lastPct, message: `${pct}%` })
              lastPct = pct
            }
          })
          // 校验和：同端点取 .sha256（格式 "<hex>  <filename>"）
          progress.report({ message: '校验中…' })
          const shaText = await fetchText(`${url}.sha256`)
          const expected = shaText.trim().split(/\s+/)[0]?.toLowerCase()
          if (!expected || sha256File(archivePath) !== expected) {
            throw new Error('sha256 校验失败')
          }
          progress.report({ message: '解压中…' })
          await untar(archivePath, versionDir)
          rmSync(archivePath, { force: true })
          const cli = cachedRuntimeCli(storageDir)
          if (!cli) throw new Error('解压后未找到 CLI（包布局异常）')
          if (process.platform !== 'win32') chmodSync(cli, 0o755)
          return cli
        } catch (err) {
          lastErr = err as Error
          rmSync(archivePath, { force: true })
        }
      }
      // 失败清理版本目录，避免半成品缓存挡住下次重试
      rmSync(versionDir, { recursive: true, force: true })
      throw new Error(
        `运行时下载失败（已尝试 ${ENDPOINTS.length} 个端点）: ${lastErr?.message ?? 'unknown'}。` +
          '可手动安装：npm i -g tianshu-tui',
      )
    },
  )
}
