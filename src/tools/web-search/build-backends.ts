import type { Config } from '../../config/schema.js'
import type { ProxyResolverOptions } from '../net/proxy-resolver.js'
import type { SearchBackend, SearchFetch } from './types.js'
import { DuckDuckGoBackend } from './duckduckgo.js'
import { BingBackend } from './bing.js'
import { BraveBackend } from './brave.js'
import { TavilyBackend } from './tavily.js'
import { createProxyAwareFetch } from './proxy-fetch.js'

export interface BuildBackendsDeps {
  fetch?: SearchFetch
  env?: NodeJS.ProcessEnv
  /**
   * Proxy resolution options sourced from `config.network.{proxy,noProxy}`.
   * When present, the production fetch is wrapped via `createProxyAwareFetch`
   * so search traffic honors the same proxy as web_fetch (config.proxy > env >
   * direct). Injected test fetches are passed through untouched — they model
   * synthetic responses and don't go to the network.
   */
  proxy?: ProxyResolverOptions
}

/**
 * Construct the ordered search backend chain from config. API-key backends are
 * always constructed (so their availability is decided at call time by
 * `isAvailable()`), letting a listed-but-unconfigured backend fall through to
 * the next entry. Unknown backend names are skipped. If nothing valid is
 * constructed, DuckDuckGo is added as a zero-config safety net.
 */
export function buildSearchBackends(config: Config, deps: BuildBackendsDeps = {}): SearchBackend[] {
  // Injected test fetches stay as-is; the real global fetch becomes proxy-aware
  // (config.network.proxy > HTTPS_PROXY/HTTP_PROXY env > direct) and is body-size
  // capped via boundedSearchFetch inside createProxyAwareFetch.
  const fetchImpl = deps.fetch ?? createProxyAwareFetch(deps.proxy)
  const env = deps.env ?? process.env
  const s = config.search

  const backends: SearchBackend[] = []
  for (const name of s.backends) {
    switch (name) {
      case 'bing':
        backends.push(new BingBackend(fetchImpl))
        break
      case 'duckduckgo':
        backends.push(new DuckDuckGoBackend(fetchImpl))
        break
      case 'brave':
        backends.push(new BraveBackend(fetchImpl, env[s.braveApiKeyEnv], s.region))
        break
      case 'tavily':
        backends.push(new TavilyBackend(fetchImpl, env[s.tavilyApiKeyEnv]))
        break
      default:
        // Unknown backend name — skip rather than fail the whole chain.
        break
    }
  }

  if (backends.length === 0) {
    backends.push(new DuckDuckGoBackend(fetchImpl))
  }
  return backends
}
