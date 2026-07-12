#!/usr/bin/env tsx

import { readFile } from 'node:fs/promises'
import {
  cacheRegressionAdvisory,
  formatOfflineCacheSummary,
  parseCacheLogJsonl,
  summarizeCacheLog,
} from '../src/cache/cache-log-summary.js'

export {
  cacheRegressionAdvisory,
  formatOfflineCacheSummary,
  parseCacheLogJsonl,
  summarizeCacheLog,
} from '../src/cache/cache-log-summary.js'

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) {
    console.error('Usage: npm exec -- tsx scripts/summarize-cache-log.ts <cache-log.jsonl>')
    process.exitCode = 2
    return
  }
  const summary = summarizeCacheLog(parseCacheLogJsonl(await readFile(path, 'utf8')))
  console.log(formatOfflineCacheSummary(summary))
  const advisory = cacheRegressionAdvisory(summary)
  if (advisory) console.warn(advisory)
}

void main().catch(error => {
  console.error(`Fatal: ${(error as Error).message}`)
  process.exitCode = 1
})
