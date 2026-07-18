import type {
  PostToolRuntimeHook,
  PostTurnRuntimeHook,
  PreTurnRuntimeHook,
  PostSessionRuntimeHook,
  RuntimeHook,
} from '../runtime-hooks.js'
import { runHooksForEvent, type HookEvent, type HookResult, type PluginHook } from '../../hooks/user-hooks-runner.js'

export interface HookResultMeta {
  event: HookEvent
  turn?: number
  toolName?: string
  error?: string
}

export interface UserHooksBridgeDeps {
  cwd: string
  sessionId?: string
  getTurn: () => number
  /** I4: surfaced as `hook_result` events on the desktop event stream. */
  emitHookResult?: (results: HookResult[], meta: HookResultMeta) => void
  /** Lazy getter for plugin-contributed hooks (absolute script paths). Plugins
   *  load after agent assembly, so this is read at every fire — not captured
   *  once at bridge creation. Merged with project .rivet/hooks.json. */
  getPluginHooks?: () => PluginHook[]
}

function bridgeHook(deps: UserHooksBridgeDeps, event: HookEvent): RuntimeHook {
  const base = { cwd: deps.cwd, sessionId: deps.sessionId, turn: deps.getTurn() }
  const emit = (results: HookResult[], extra?: Partial<HookResultMeta>) => {
    deps.emitHookResult?.(results, { event, turn: deps.getTurn(), ...extra })
  }
  // Shared runner: project hooks (.rivet/hooks.json) + plugin hooks (merged).
  const run = (ctx: Parameters<typeof runHooksForEvent>[1]) =>
    runHooksForEvent(deps.cwd, ctx, deps.getPluginHooks?.())

  if (event === 'preTurn') {
    return {
      phase: 'preTurn',
      name: 'user-hooks-preTurn',
      run() {
        emit(run({ ...base, event: 'preTurn', turn: deps.getTurn() }))
      },
    } satisfies PreTurnRuntimeHook
  }

  if (event === 'postTurn') {
    return {
      phase: 'postTurn',
      name: 'user-hooks-postTurn',
      run() {
        emit(run({ ...base, event: 'postTurn', turn: deps.getTurn() }))
      },
    } satisfies PostTurnRuntimeHook
  }

  if (event === 'postSession') {
    return {
      phase: 'postSession',
      name: 'user-hooks-postSession',
      run() {
        emit(run({ ...base, event: 'postSession', turn: deps.getTurn() }))
      },
    } satisfies PostSessionRuntimeHook
  }

  return {
    phase: 'postTool',
    name: 'user-hooks-postTool',
    run(_ctx, tool) {
      emit(
        run({
          ...base,
          event: 'postTool',
          turn: deps.getTurn(),
          toolName: tool.name,
          toolResult: tool.success ? 'success' : 'failure',
        }),
        { toolName: tool.name },
      )
    },
  } satisfies PostToolRuntimeHook
}

/** I4: run user-configured `onError` hooks outside the normal phase pipeline. */
export function runOnErrorHooks(deps: UserHooksBridgeDeps, error: string): void {
  if (!deps.emitHookResult) return
  const results = runHooksForEvent(deps.cwd, {
    cwd: deps.cwd,
    sessionId: deps.sessionId,
    turn: deps.getTurn(),
    event: 'onError',
    error,
  }, deps.getPluginHooks?.())
  deps.emitHookResult(results, { event: 'onError', turn: deps.getTurn(), error })
}

export function createUserHooksBridge(deps: UserHooksBridgeDeps): RuntimeHook[] {
  return [
    bridgeHook(deps, 'preTurn'),
    bridgeHook(deps, 'postTurn'),
    bridgeHook(deps, 'postTool'),
    bridgeHook(deps, 'postSession'),
  ]
}
