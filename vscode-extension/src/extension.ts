/**
 * 天枢 VS Code / Cursor 扩展入口。
 *
 * 职责边界（计划 §7「不做的事」）：插件内不实现任何 agent 逻辑，一切智能在
 * sidecar 内核；本文件只做 sidecar 生命周期 + 座舱视图装配。
 */
import * as vscode from 'vscode'
import { launchSidecar, SidecarLaunchError, type SidecarHandle } from './sidecar/launcher.js'
import { SidecarClient } from './sidecar/client.js'
import { CockpitProvider } from './views/cockpit-provider.js'
import { registerChangesView } from './views/changes-view.js'
import { DelegationExecutor } from './delegation/executor.js'
import { StatusBarController } from './views/status-bar.js'
import { registerCommitMessageCommand } from './scm/commit-message.js'
import { ensureRuntime, rivetOnPath } from './sidecar/runtime-downloader.js'

let sidecar: SidecarHandle | undefined
let clientPromise: Promise<SidecarClient> | undefined
let output: vscode.OutputChannel | undefined
let delegation: DelegationExecutor | undefined
let statusBar: StatusBarController | undefined
let globalStorageDir = ''

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('天枢 Sidecar')
  globalStorageDir = context.globalStorageUri.fsPath

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!cwd) {
    // 无工作区不启动 sidecar；视图内提示用户打开文件夹。
    output.appendLine('[tianshu] no workspace folder — sidecar not started')
  }

  const provider: CockpitProvider = new CockpitProvider(
    context.extensionUri,
    (): Promise<SidecarClient> => ensureClient(provider, cwd),
    cwd ?? '',
  )

  const changesTree = registerChangesView(context, () => ensureClient(provider, cwd), cwd ?? '')
  delegation = new DelegationExecutor(() => ensureClient(provider, cwd), cwd ?? '')
  delegation.register(context)
  statusBar = new StatusBarController()
  context.subscriptions.push(statusBar)
  registerCommitMessageCommand(context)

  provider.onSessionActivity = (kind, sessionId) => {
    if (kind === 'attach') {
      changesTree.setSession(sessionId)
      void delegation?.attachSession(sessionId)
    } else {
      changesTree.scheduleRefresh()
    }
  }

  // 状态栏：会话 status → 运行指示；审批事件 → 待批计数
  let pendingApprovals = 0
  provider.onSessionEvent = (ev) => {
    if (ev.type === 'status') {
      statusBar?.setSessionStatus(String((ev.data as { status?: unknown }).status ?? ''))
    } else if (ev.type === 'approval_required') {
      statusBar?.setPendingApprovals(++pendingApprovals)
    } else if (ev.type === 'approval_resolved') {
      pendingApprovals = Math.max(0, pendingApprovals - 1)
      statusBar?.setPendingApprovals(pendingApprovals)
    } else if (ev.type === 'done') {
      pendingApprovals = 0
      statusBar?.setPendingApprovals(0)
      statusBar?.setSessionStatus('idle')
    }
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CockpitProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('tianshu.newSession', () => {
      void vscode.commands.executeCommand('tianshu.cockpit.focus')
    }),
    vscode.commands.registerCommand('tianshu.restartSidecar', async () => {
      disposeSidecar()
      try {
        await ensureClient(provider, cwd)
        void vscode.window.showInformationMessage('天枢内核已重启')
      } catch (err) {
        void vscode.window.showErrorMessage(`天枢内核重启失败: ${(err as Error).message}`)
      }
    }),
    vscode.commands.registerCommand('tianshu.showSidecarLog', () => output?.show()),
    vscode.commands.registerCommand('tianshu.sendSelection', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || !cwd) return
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false)
      const sel = editor.selection
      const snippet = editor.document.getText(sel).trimEnd()
      const ref = sel.isEmpty
        ? `@file:${rel}`
        : `@file:${rel} (L${sel.start.line + 1}-L${sel.end.line + 1})\n\`\`\`\n${snippet}\n\`\`\``
      await vscode.commands.executeCommand('tianshu.cockpit.focus')
      // 视图可能刚被唤起，webview 尚在装配——短暂延迟后投递
      setTimeout(() => provider.insertToComposer(ref), 300)
    }),
    vscode.commands.registerCommand('tianshu.inlineEdit', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || !cwd) {
        void vscode.window.showInformationMessage('请先打开工作区中的文件')
        return
      }
      const instruction = await vscode.window.showInputBox({
        prompt: '描述要对选区/文件做的修改',
        placeHolder: '例如：提取为独立函数并加单元测试',
      })
      if (!instruction?.trim()) return
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false)
      const sel = editor.selection
      const prefix = sel.isEmpty
        ? `@file:${rel}`
        : `@file:${rel} (L${sel.start.line + 1}-L${sel.end.line + 1})`
      const text = `${prefix}\n${instruction.trim()}`
      await vscode.commands.executeCommand('tianshu.cockpit.focus')
      await provider.submitPrompt(text)
    }),
    { dispose: disposeSidecar },
  )
}

async function ensureClient(provider: CockpitProvider, cwd: string | undefined): Promise<SidecarClient> {
  if (!cwd) throw new Error('请先打开一个工作区文件夹')
  if (!clientPromise) {
    clientPromise = (async () => {
      provider.notifySidecarState('starting')
      statusBar?.setSidecarState('starting')
      const cfg = vscode.workspace.getConfiguration('tianshu')
      try {
        // CLI 三级探测：① settings 显式路径 ② PATH 上的 rivet
        // ③ 自包含运行时（globalStorage 缓存，缺则带进度下载自举）
        let cliPath = cfg.get<string>('cliPath')?.trim() || undefined
        if (!cliPath && !(await rivetOnPath())) {
          output?.appendLine('[tianshu] rivet not on PATH — bootstrapping self-contained runtime')
          cliPath = await ensureRuntime(globalStorageDir)
          output?.appendLine(`[tianshu] runtime ready: ${cliPath}`)
        }
        sidecar = await launchSidecar({
          cwd,
          cliPath,
          port: cfg.get<number>('serverPort') || 0,
          onLog: (line) => output?.appendLine(line),
        })
      } catch (err) {
        clientPromise = undefined
        if (err instanceof SidecarLaunchError && err.reason === 'cli-not-found') {
          void vscode.window
            .showErrorMessage('未找到 rivet CLI（天枢内核）。', '安装说明', '打开设置')
            .then((pick) => {
              if (pick === '安装说明') void vscode.env.openExternal(vscode.Uri.parse('https://github.com/tianshu-ai/Tianshu-Tui#install'))
              if (pick === '打开设置') void vscode.commands.executeCommand('workbench.action.openSettings', 'tianshu.cliPath')
            })
        }
        provider.notifySidecarState('dead', (err as Error).message)
        statusBar?.setSidecarState('dead', (err as Error).message)
        throw err
      }
      sidecar.onExit((code) => {
        output?.appendLine(`[tianshu] sidecar exited (code ${code})`)
        provider.notifySidecarState('dead', `内核进程退出（code ${code}）`)
        statusBar?.setSidecarState('dead', `内核进程退出（code ${code}）`)
        clientPromise = undefined
        sidecar = undefined
      })
      provider.notifySidecarState('ready')
      statusBar?.setSidecarState('ready')
      return new SidecarClient(sidecar.baseUrl, sidecar.token)
    })()
  }
  return clientPromise
}

function disposeSidecar(): void {
  delegation?.detach()
  sidecar?.dispose()
  sidecar = undefined
  clientPromise = undefined
}

export function deactivate(): void {
  disposeSidecar()
}
