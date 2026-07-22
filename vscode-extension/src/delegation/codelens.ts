/**
 * Per-file Accept / Reject CodeLens for pending delegated edits.
 */
import * as vscode from 'vscode'
import type { DiffDecorationController } from './diff-decorations.js'

export class DelegateCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this.changeEmitter.event

  constructor(private readonly decorations: DiffDecorationController) {}

  refresh(): void {
    this.changeEmitter.fire()
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const pending = this.decorations.get(document.uri)
    if (!pending) return []
    const range = new vscode.Range(0, 0, 0, 0)
    return [
      new vscode.CodeLens(range, {
        title: '✓ 接受天枢编辑',
        command: 'tianshu.acceptEdit',
        arguments: [document.uri],
      }),
      new vscode.CodeLens(range, {
        title: '✗ 拒绝',
        command: 'tianshu.rejectEdit',
        arguments: [document.uri],
      }),
    ]
  }
}
