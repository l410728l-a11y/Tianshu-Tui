/**
 * 座舱样式——全部映射 --vscode-* 主题变量，随宿主主题（含 Cursor）自动适配。
 * 以 JS 常量内联注入：webview HTML 只加载单个 script，免去 css 资源路径与
 * CSP style-src 摩擦。
 */
export const CSS = `
* { box-sizing: border-box; }
body { padding: 0; margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
.app { display: flex; flex-direction: column; height: 100vh; }

.header { display: flex; gap: 4px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.header select { flex: 1; min-width: 0; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 2px 4px; border-radius: 2px; }
.header button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 8px; cursor: pointer; border-radius: 2px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot.live { background: var(--vscode-testing-iconPassed, #4caf50); }
.dot.idle { background: var(--vscode-descriptionForeground); }
.dot.dead { background: var(--vscode-errorForeground); }

.banner { padding: 4px 8px; font-size: 12px; }
.banner.error { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }

.messages { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.empty { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 16px 8px; }

.msg { max-width: 100%; white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.5; }
.msg.user { background: var(--vscode-input-background); border-left: 2px solid var(--vscode-focusBorder); padding: 6px 8px; border-radius: 3px; }
.msg.assistant { padding: 0 2px; }
.msg.info { color: var(--vscode-descriptionForeground); font-size: 12px; }
.msg.thinking summary, .msg.tool summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; user-select: none; }
.msg pre { background: var(--vscode-textCodeBlock-background); padding: 6px 8px; border-radius: 3px; overflow-x: auto; font-size: 12px; margin: 4px 0 0 0; font-family: var(--vscode-editor-font-family); }
.msg.tool.error summary { color: var(--vscode-errorForeground); }

.msg.approval { border: 1px solid var(--vscode-inputValidation-warningBorder, #b8860b); border-radius: 4px; padding: 8px; }
.msg.approval .actions { display: flex; gap: 8px; margin-top: 6px; }
.msg.approval button { border: none; padding: 3px 12px; cursor: pointer; border-radius: 2px; }
.msg.approval .approve { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.msg.approval .deny { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.msg.approval .decision { margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 12px; }

.toolbar { display: flex; gap: 4px; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
.toolbar select { max-width: 46%; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 1px 4px; border-radius: 2px; font-size: 11px; }
.badge.plan { font-size: 11px; color: var(--vscode-charts-yellow, #cca700); }

.todo-panel { border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 8px; font-size: 12px; }
.todo-panel summary { cursor: pointer; color: var(--vscode-descriptionForeground); user-select: none; }
.todo-panel ul { margin: 4px 0 2px 0; padding-left: 8px; list-style: none; }
.todo-panel li { line-height: 1.6; }
.todo-panel li.completed { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
.todo-panel li.in_progress { color: var(--vscode-charts-blue, #3794ff); }
.todo-panel li.cancelled { color: var(--vscode-descriptionForeground); }

.file-link { margin-left: 6px; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; }
.file-link:hover { text-decoration: underline; }

.msg.question { border: 1px solid var(--vscode-focusBorder); border-radius: 4px; padding: 8px; }
.msg.question .q-prompt { margin-bottom: 4px; }
.msg.question .q-options { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.msg.question .q-options button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid transparent; padding: 3px 10px; cursor: pointer; border-radius: 3px; font-size: 12px; }
.msg.question .q-options button.picked { border-color: var(--vscode-focusBorder); background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.msg.question .actions button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 12px; cursor: pointer; border-radius: 2px; }
.msg.question .decision { color: var(--vscode-descriptionForeground); font-size: 12px; }

.mention-list { max-height: 180px; overflow-y: auto; border: 1px solid var(--vscode-dropdown-border); border-radius: 3px; background: var(--vscode-dropdown-background); }
.mention-item { padding: 3px 8px; cursor: pointer; font-size: 12px; font-family: var(--vscode-editor-font-family); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mention-item:hover { background: var(--vscode-list-hoverBackground); }

.composer { border-top: 1px solid var(--vscode-panel-border); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.composer textarea { width: 100%; min-height: 56px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 6px 8px; font-family: inherit; font-size: 13px; }
.composer textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
.composer-actions { display: flex; justify-content: flex-end; gap: 8px; }
.composer-actions button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 14px; cursor: pointer; border-radius: 2px; }
.composer-actions button:disabled { opacity: 0.5; cursor: default; }
.composer-actions .abort { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
`
