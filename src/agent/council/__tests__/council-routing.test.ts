import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  routeCouncilSeat,
  buildCouncilRoutingShadow,
  councilRoutingShadowKind,
  persistCouncilRoutingShadow,
  pillarOf,
  THREE_PILLAR_COUNCIL_SEATS,
  mergeSeatOverrides,
  type CouncilRoutingShadowStore,
} from '../council-routing.js'

describe('三柱席位路由（卡巴拉对抗拓扑）', () => {
  it('pillarOf：破军/天机/天璇 → expansion；天权/华盖/天府/天梁 → constraint；瑶光 → balance', () => {
    assert.equal(pillarOf('pojun'), 'expansion')
    assert.equal(pillarOf('tianji'), 'expansion')
    assert.equal(pillarOf('tianxuan'), 'expansion')
    assert.equal(pillarOf('tianquan'), 'constraint')
    assert.equal(pillarOf('huagai'), 'constraint')
    assert.equal(pillarOf('tianfu'), 'constraint')
    assert.equal(pillarOf('tianliang'), 'constraint')
    assert.equal(pillarOf('yaoguang'), 'balance')
    assert.equal(pillarOf('unknown-domain'), undefined)
  })

  it('THREE_PILLAR_COUNCIL_SEATS：三柱齐备（扩张≥2 / 约束≥2 / 平衡=1），authority 不重复', () => {
    const pillars = THREE_PILLAR_COUNCIL_SEATS.map(s => pillarOf(s.authority))
    assert.ok(pillars.filter(p => p === 'expansion').length >= 2, '扩张柱至少 2 席')
    assert.ok(pillars.filter(p => p === 'constraint').length >= 2, '约束柱至少 2 席')
    assert.equal(pillars.filter(p => p === 'balance').length, 1, '平衡柱恰 1 席（合成裁决唯一）')
    const auths = THREE_PILLAR_COUNCIL_SEATS.map(s => s.authority)
    assert.equal(new Set(auths).size, auths.length)
  })

  it('THREE_PILLAR_COUNCIL_SEATS：约束柱与平衡柱带瑶光门（tierHint strong + noDowngrade）', () => {
    for (const seat of THREE_PILLAR_COUNCIL_SEATS) {
      const p = pillarOf(seat.authority)
      if (p === 'constraint' || p === 'balance') {
        assert.equal(seat.tierHint, 'strong', `${seat.authority} 应声明 strong`)
        assert.equal(seat.noDowngrade, true, `${seat.authority} 应带瑶光门`)
      }
    }
  })

  it('mergeSeatOverrides：配置席位按 authority 覆盖 provider/model（异构默认接线），未匹配席保持原样', () => {
    const merged = mergeSeatOverrides(THREE_PILLAR_COUNCIL_SEATS, [
      { authority: 'pojun', provider: 'glm', model: 'glm-5' },
      { authority: 'yaoguang', provider: 'deepseek', model: 'deepseek-v4-pro' },
      { authority: 'not-in-pillars', provider: 'x', model: 'y' },
    ])
    assert.equal(merged.find(s => s.authority === 'pojun')?.provider, 'glm')
    assert.equal(merged.find(s => s.authority === 'pojun')?.model, 'glm-5')
    assert.equal(merged.find(s => s.authority === 'yaoguang')?.model, 'deepseek-v4-pro')
    assert.equal(merged.find(s => s.authority === 'tianquan')?.provider, undefined)
    // 覆盖不改变席位数量与章程
    assert.equal(merged.length, THREE_PILLAR_COUNCIL_SEATS.length)
    assert.equal(merged.find(s => s.authority === 'pojun')?.charter, THREE_PILLAR_COUNCIL_SEATS.find(s => s.authority === 'pojun')?.charter)
  })
})

describe('routeCouncilSeat — authority 升级 + 瑶光门', () => {
  it('天府高风险席 → strong（authority 升级路径，council_expert 无 tierLock）', () => {
    const r = routeCouncilSeat({ authority: 'tianfu' }, { riskTier: 'high' })
    assert.equal(r.tier, 'strong')
    assert.equal(r.recommendedTier, 'strong')
    assert.equal(r.hardFloor, 'strong')
    assert.equal(r.gated, false)
  })

  it('天璇规划席 → balanced', () => {
    const r = routeCouncilSeat({ authority: 'tianxuan' })
    assert.equal(r.tier, 'balanced')
  })

  it('未知权能席默认 → cheap', () => {
    const r = routeCouncilSeat({ authority: 'tianji' })
    assert.equal(r.tier, 'cheap')
    assert.equal(r.hardFloor, undefined)
  })

  it('瑶光门：noDowngrade + tierHint:strong 把弱推荐席抬到 strong', () => {
    const r = routeCouncilSeat({ authority: 'tianji', tierHint: 'strong', noDowngrade: true })
    assert.equal(r.tier, 'strong')
    assert.equal(r.recommendedTier, 'cheap')
    assert.equal(r.gated, true)
  })

  it('反证：去掉 noDowngrade → tierHint 仅记录，tier 回落推荐 cheap', () => {
    const r = routeCouncilSeat({ authority: 'tianji', tierHint: 'strong', noDowngrade: false })
    assert.equal(r.tier, 'cheap')
    assert.equal(r.gated, false)
  })

  it('瑶光门只抬升不降级：noDowngrade + tierHint:cheap 不会把天府高风险席压低', () => {
    const r = routeCouncilSeat({ authority: 'tianfu', tierHint: 'cheap', noDowngrade: true }, { riskTier: 'high' })
    assert.equal(r.tier, 'strong', 'cheap hint 不得击穿 policy strong 硬地板')
  })
})

describe('council routing shadow — append-only', () => {
  it('key 含 seat+timestamp，两席/两次不互相覆盖', () => {
    const base = { sessionId: 's1', objectiveHash: 'h1', timestamp: 100 }
    const a = councilRoutingShadowKind({ ...base, seat: 'tianfu' })
    const b = councilRoutingShadowKind({ ...base, seat: 'tianxuan' })
    const c = councilRoutingShadowKind({ ...base, seat: 'tianfu', timestamp: 200 })
    assert.notEqual(a, b)
    assert.notEqual(a, c)
    assert.match(a, /^council_routing_shadow:s1:h1:tianfu:100$/)
  })

  it('buildCouncilRoutingShadow 映射 route → 事件体', () => {
    const route = routeCouncilSeat({ authority: 'tianfu' }, { riskTier: 'high' })
    const ev = buildCouncilRoutingShadow({ sessionId: 's1', objectiveHash: 'h1', route, timestamp: 5 })
    assert.equal(ev.seat, 'tianfu')
    assert.equal(ev.finalTier, 'strong')
    assert.equal(ev.recommendedTier, 'strong')
    assert.equal(ev.timestamp, 5)
  })

  it('persist 落盘到 store；store 抛错被吞，不影响调用方', () => {
    const saved: Array<{ kind: string; json: string }> = []
    const store: CouncilRoutingShadowStore = { saveBanditState: (kind, json) => { saved.push({ kind, json }) } }
    const route = routeCouncilSeat({ authority: 'tianfu' }, { riskTier: 'high' })
    const ev = buildCouncilRoutingShadow({ sessionId: 's1', objectiveHash: 'h1', route, timestamp: 5 })
    persistCouncilRoutingShadow(store, ev)
    assert.equal(saved.length, 1)
    const throwing: CouncilRoutingShadowStore = { saveBanditState: () => { throw new Error('db down') } }
    assert.doesNotThrow(() => persistCouncilRoutingShadow(throwing, ev))
    assert.doesNotThrow(() => persistCouncilRoutingShadow(undefined, ev))
  })
})
