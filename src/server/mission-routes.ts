/**
 * /missions/* routes — P1 任务身份化的桌面端 API 面。
 * All routes are Bearer-gated (fail-closed).
 *
 *   GET  /missions?cwd=            list（可选按项目 cwd 过滤）
 *   GET  /missions/:id             get 单个
 *   POST /missions/:id/archive     归档
 *   POST /missions/:id/rename      { title: string }
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import type { MissionStore } from './mission-store.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

export function buildMissionRoutes(store: MissionStore, apiToken?: string): Record<string, RouteHandler> {
  return {
    'GET /missions': withAuth((_body, params) => {
      const cwd = typeof params?.cwd === 'string' && params.cwd.trim() ? params.cwd : undefined
      return { status: 200, body: store.list(cwd) }
    }, apiToken),

    'GET /missions/:id': withAuth((_body, params) => {
      const id = params?.id ?? ''
      const mission = store.get(id)
      if (!mission) return { status: 404, body: { error: 'Mission not found' } }
      return { status: 200, body: mission }
    }, apiToken),

    'POST /missions/:id/archive': withAuth((_body, params) => {
      const id = params?.id ?? ''
      const mission = store.archive(id)
      if (!mission) return { status: 404, body: { error: 'Mission not found' } }
      return { status: 200, body: mission }
    }, apiToken),

    'POST /missions/:id/rename': withAuth((body, params) => {
      const id = params?.id ?? ''
      const data = (body ?? {}) as { title?: unknown }
      const title = typeof data.title === 'string' ? data.title.trim() : ''
      if (!title) return { status: 400, body: { error: 'Missing "title"' } }
      const mission = store.update(id, { title })
      if (!mission) return { status: 404, body: { error: 'Mission not found' } }
      return { status: 200, body: mission }
    }, apiToken),
  }
}
