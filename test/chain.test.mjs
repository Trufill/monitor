import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MODULES_PAGE_CALLDATA, SAFE_SLOTS, SEL, codeSha256 } from '../src/abi.mjs'
import { checkChain, diffGovernance } from '../src/chain.mjs'

const NOW = new Date('2026-09-29T10:00:00Z')
const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const C = {
  router: '0x877a4bb039c8146cfb8daae36cfb5ae1e9bd1060',
  feeSwitch: '0x802f0ca0f62bd66c2117b4392d8350578e442cdc',
  timelock: '0x9a8f32f16fb9d99ba26ee957d5ca53798ebf256c',
  safe: '0x7999ef46136a40a6769b1c2226510426689c22e7',
}
const OWNER = '0xda37f17cfb086b9f4c730aeb7a205b04186a66a5'
const SWAP_ROUTER = '0x2626664c2603336e57b271c5c0b26f421741e481'
const ZERO = '0x' + '0'.repeat(40)
const CODE = { router: '0x6080aa', feeSwitch: '0x6080bb', timelock: '0x6080cc', safe: '0x6080dd' }

/** Состояние цепи, как его видит один узел. `patch` меняет отдельные ответы. */
function chainState(patch = {}) {
  const s = {
    nonce: 1,
    owners: [OWNER],
    feeBps: 0,
    ...patch,
  }
  const calls = {
    [`${C.router}:${SEL.feeSwitch}`]: '0x' + word(C.feeSwitch),
    [`${C.router}:${SEL.swapRouter}`]: '0x' + word(SWAP_ROUTER),
    [`${C.feeSwitch}:${SEL.owner}`]: '0x' + word(C.timelock),
    [`${C.feeSwitch}:${SEL.pendingOwner}`]: '0x' + word(ZERO),
    [`${C.feeSwitch}:${SEL.feeBps}`]: '0x' + word(s.feeBps.toString(16)),
    [`${C.feeSwitch}:${SEL.feeCollector}`]: '0x' + word(C.safe),
    [`${C.timelock}:${SEL.owner}`]: '0x' + word(C.safe),
    [`${C.timelock}:${SEL.pendingOwner}`]: '0x' + word(ZERO),
    [`${C.timelock}:${SEL.feeSwitch}`]: '0x' + word(C.feeSwitch),
    [`${C.safe}:${SEL.getOwners}`]: '0x' + word('20') + word(s.owners.length.toString(16)) + s.owners.map(word).join(''),
    [`${C.safe}:${SEL.getThreshold}`]: '0x' + word('1'),
    [`${C.safe}:${SEL.nonce}`]: '0x' + word(s.nonce.toString(16)),
    [`${C.safe}:${MODULES_PAGE_CALLDATA}`]: '0x' + word('40') + word('1') + word('0'),
  }
  const slots = {
    [`${C.safe}:${SAFE_SLOTS.guard}`]: '0x' + word('0'),
    [`${C.safe}:${SAFE_SLOTS.fallbackHandler}`]: '0x' + word('fd0732dc9e303f09fcef3a7388ad10a83459ec99'),
    [`${C.safe}:${SAFE_SLOTS.singleton}`]: '0x' + word('29fcb43b46531bca003ddc8fcb67ffe91900c762'),
  }
  return { calls, slots, logs: s.logs ?? [] }
}

function fakeNode(host, state, { chainId = 8453, lagSeconds = 2, failOn = null } = {}) {
  const rpc = async (method, params) => {
    if (failOn && failOn(method)) throw new Error(`${host}: ${method}: HTTP 429`)
    switch (method) {
      case 'eth_chainId':
        return '0x' + chainId.toString(16)
      case 'eth_getBlockByNumber':
        return { number: '0x31830a0', timestamp: '0x' + Math.floor(NOW.getTime() / 1000 - lagSeconds).toString(16) }
      case 'eth_getCode':
        return CODE[Object.keys(C).find((k) => C[k] === params[0].toLowerCase())]
      case 'eth_call':
        return state.calls[`${params[0].to.toLowerCase()}:${params[0].data}`]
      case 'eth_getStorageAt':
        return state.slots[`${params[0].toLowerCase()}:${params[1]}`]
      case 'eth_getLogs':
        return state.logs
      default:
        throw new Error(`неожиданный метод ${method}`)
    }
  }
  rpc.host = host
  return rpc
}

function config() {
  return {
    base: {
      chainId: 8453,
      rpcs: [{ url: 'https://a.example' }, { url: 'https://b.example' }, { url: 'https://c.example' }],
      maxBlockLagSeconds: 180,
      logWindowBlocks: 100,
      logChunkBlocks: 50,
      contracts: C,
      expected: {
        code: Object.fromEntries(Object.entries(CODE).map(([k, v]) => [k, codeSha256(v)])),
        router: { feeSwitch: C.feeSwitch, swapRouter: SWAP_ROUTER.toUpperCase().replace('0X', '0x') },
        feeSwitch: { owner: C.timelock, pendingOwner: ZERO, feeBps: 0, feeCollector: C.safe },
        timelock: { owner: C.safe, pendingOwner: ZERO, feeSwitch: C.feeSwitch },
        safe: {
          owners: [OWNER],
          threshold: 1,
          nonce: 1,
          modules: [],
          guard: ZERO,
          fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
          singleton: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
        },
      },
    },
  }
}

async function run(nodes) {
  const byUrl = Object.fromEntries(nodes.map((n, i) => [config().base.rpcs[i].url, n]))
  const results = await checkChain(config(), { makeRpc: (entry) => byUrl[entry.url], now: () => NOW })
  return Object.fromEntries(results.map((r) => [r.id, r]))
}

test('всё как ожидается — шесть зелёных строк, адреса сравниваются без учёта регистра', async () => {
  const r = await run([fakeNode('a', chainState()), fakeNode('b', chainState()), fakeNode('c', chainState())])
  assert.deepEqual(Object.keys(r), ['base.rpc', 'base.code', 'base.router', 'base.feeSwitch', 'base.timelock', 'base.safe'])
  for (const result of Object.values(r)) assert.equal(result.ok, true, `${result.id}: ${result.detail}`)
  assert.match(r['base.safe'].info, /nonce 1/)
})

test('nonce Safe сдвинулся на обоих узлах — тревога с подтверждением', async () => {
  const r = await run([fakeNode('a', chainState({ nonce: 2 })), fakeNode('b', chainState({ nonce: 2 })), fakeNode('c', chainState())])
  assert.equal(r['base.safe'].ok, false)
  assert.match(r['base.safe'].detail, /safe\.nonce: 2 вместо 1 \(подтверждено b\)/)
  assert.equal(r['base.feeSwitch'].ok, true)
})

test('расхождение одного узла, не подтверждённое вторым, — не тревога', async () => {
  const r = await run([fakeNode('a', chainState({ feeBps: 30 })), fakeNode('b', chainState()), fakeNode('c', chainState())])
  assert.equal(r['base.feeSwitch'].ok, true)
  assert.match(r['base.feeSwitch'].info, /a показал расхождение .*feeBps: 30 вместо 0.*b — нет: сбой узла/)
})

test('подтвердить некому — тревога с пометкой, а не молчание', async () => {
  const r = await run([
    fakeNode('a', chainState({ feeBps: 30 })),
    fakeNode('b', chainState(), { chainId: 1 }),
    fakeNode('c', chainState(), { lagSeconds: 900 }),
  ])
  assert.equal(r['base.feeSwitch'].ok, false)
  assert.match(r['base.feeSwitch'].detail, /второй узел для подтверждения недоступен/)
  assert.match(r['base.rpc'].info, /b: chainId 1, ожидался 8453/)
  assert.match(r['base.rpc'].info, /c: голова отстаёт на 900 с/)
})

test('порядок владельцев Safe не важен, состав — важен', async () => {
  const two = [OWNER, '0x1111111111111111111111111111111111111111']
  const cfg = config()
  const actual = { safe: { ...cfg.base.expected.safe, owners: [...two].reverse() } }
  assert.deepEqual(diffGovernance(actual, { safe: { owners: two } }), {})
  assert.deepEqual(Object.keys(diffGovernance(actual, { safe: { owners: [OWNER] } })), ['safe'])
})

test('ни один узел не годен — base.rpc красный, проверок управления нет', async () => {
  const r = await run([
    fakeNode('a', chainState(), { failOn: () => true }),
    fakeNode('b', chainState(), { chainId: 1 }),
    fakeNode('c', chainState(), { lagSeconds: 900 }),
  ])
  assert.deepEqual(Object.keys(r), ['base.rpc'])
  assert.equal(r['base.rpc'].ok, false)
})

test('чтение упало на первом узле — читает следующий', async () => {
  const r = await run([
    fakeNode('a', chainState(), { failOn: (m) => m === 'eth_call' }),
    fakeNode('b', chainState()),
    fakeNode('c', chainState()),
  ])
  assert.equal(r['base.safe'].ok, true)
  assert.match(r['base.rpc'].info, /чтение: b.*чтение не удалось: a: eth_call: HTTP 429/)
})

test('события к тревоге: расшифровка Queued и переход на другой узел при отказе getLogs', async () => {
  const queued = {
    address: C.timelock,
    topics: ['0x4dac892ca3f8073fc4fa78fdc9d3da74945afe0f465d97f3196ae9ba9eaab450', '0x' + 'ab'.repeat(32)],
    data: '0x' + word('1e') + word((1759312800).toString(16)),
    blockNumber: '0x31830a0',
    transactionHash: '0x' + '11'.repeat(32),
  }
  const received = { ...queued, address: C.safe, topics: ['0x3d0ce9bfc3ed7d6862dbb28b2dea94561fe714a1b4d019aa8af39730d1ad7c3d'] }
  const state = chainState({ nonce: 2, logs: [received, queued] })
  const r = await run([fakeNode('a', state, { failOn: (m) => m === 'eth_getLogs' }), fakeNode('b', state), fakeNode('c', state)])
  const detail = r['base.safe'].detail
  assert.match(detail, /timelock\.Queued \(id=0xabababababababab…, newFeeBps=30, readyAt=2025-10-01T10:00:00\.000Z\)/)
  assert.doesNotMatch(detail, /SafeReceived|0x3d0ce9bf/)
})
