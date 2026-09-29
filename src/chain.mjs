import {
  EVENTS,
  MODULES_PAGE_CALLDATA,
  SAFE_RECEIVED_TOPIC,
  SAFE_SLOTS,
  SEL,
  codeSha256,
  codeSize,
  decodeAddress,
  decodeAddressArray,
  decodeUint,
  wordToAddress,
  wordToBigInt,
  words,
} from './abi.mjs'
import { describeError } from './net.mjs'

/** Группы управления на цепи: каждая — отдельная проверка и отдельная строка тревоги. */
export const GOVERNANCE_GROUPS = ['code', 'router', 'feeSwitch', 'timelock', 'safe']

/** Сколько последних событий управления приложить к тревоге. */
const MAX_EVENTS = 10

/**
 * Узел годен, если это Base и его голова свежая. Отставший узел отвечает «как было» — ровно тот
 * случай, когда изменение управления прошло бы мимо, поэтому он отбрасывается, а не читается.
 */
export async function probeRpc(rpc, { chainId, maxBlockLagSeconds, now }) {
  const id = Number(BigInt(await rpc('eth_chainId')))
  if (id !== chainId) throw new Error(`${rpc.host}: chainId ${id}, ожидался ${chainId}`)
  const block = await rpc('eth_getBlockByNumber', ['latest', false])
  const number = BigInt(block.number)
  const lagSeconds = Math.round(now.getTime() / 1000 - Number(BigInt(block.timestamp)))
  if (lagSeconds > maxBlockLagSeconds) throw new Error(`${rpc.host}: голова отстаёт на ${lagSeconds} с`)
  return { number, lagSeconds }
}

/**
 * Состояние управления целиком, на одном блоке одного узла: чтения не смешивают разные моменты.
 * Последовательно, а не залпом: публичные узлы режут частые запросы, а двадцать вызовов раз в
 * пятнадцать минут укладываются в секунды.
 */
export async function readGovernance(rpc, contracts, blockTag) {
  const call = (to, data) => rpc('eth_call', [{ to, data }, blockTag])
  const slot = (address, position) => rpc('eth_getStorageAt', [address, position, blockTag])

  const code = {}
  const codeSizes = {}
  for (const [name, address] of Object.entries(contracts)) {
    const hex = await rpc('eth_getCode', [address, blockTag])
    code[name] = codeSha256(hex)
    codeSizes[name] = codeSize(hex)
  }
  return {
    code,
    codeSizes,
    router: {
      feeSwitch: decodeAddress(await call(contracts.router, SEL.feeSwitch)),
      swapRouter: decodeAddress(await call(contracts.router, SEL.swapRouter)),
    },
    feeSwitch: {
      owner: decodeAddress(await call(contracts.feeSwitch, SEL.owner)),
      pendingOwner: decodeAddress(await call(contracts.feeSwitch, SEL.pendingOwner)),
      feeBps: Number(decodeUint(await call(contracts.feeSwitch, SEL.feeBps))),
      feeCollector: decodeAddress(await call(contracts.feeSwitch, SEL.feeCollector)),
    },
    timelock: {
      owner: decodeAddress(await call(contracts.timelock, SEL.owner)),
      pendingOwner: decodeAddress(await call(contracts.timelock, SEL.pendingOwner)),
      feeSwitch: decodeAddress(await call(contracts.timelock, SEL.feeSwitch)),
    },
    safe: {
      owners: decodeAddressArray(await call(contracts.safe, SEL.getOwners)),
      threshold: Number(decodeUint(await call(contracts.safe, SEL.getThreshold))),
      nonce: Number(decodeUint(await call(contracts.safe, SEL.nonce))),
      modules: decodeAddressArray(await call(contracts.safe, MODULES_PAGE_CALLDATA)),
      guard: decodeAddress(await slot(contracts.safe, SAFE_SLOTS.guard)),
      fallbackHandler: decodeAddress(await slot(contracts.safe, SAFE_SLOTS.fallbackHandler)),
      singleton: decodeAddress(await slot(contracts.safe, SAFE_SLOTS.singleton)),
    },
  }
}

/** Адреса сравниваются без учёта регистра, наборы (владельцы, модули) — без учёта порядка. */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize).sort()
  if (typeof value === 'string') return value.toLowerCase()
  return value
}

function show(value) {
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value)
}

/**
 * Расхождения с ожидаемым по группам: `{ safe: ['safe.nonce: 2 вместо 1'], ... }`.
 * Сравниваются только поля, перечисленные в ожидаемом: config.json — единственное место, где
 * записано, каким управление должно быть.
 */
export function diffGovernance(actual, expected) {
  const diffs = {}
  for (const group of GOVERNANCE_GROUPS) {
    for (const [field, want] of Object.entries(expected[group] ?? {})) {
      const got = actual[group]?.[field]
      if (JSON.stringify(normalize(got)) === JSON.stringify(normalize(want))) continue
      const line =
        group === 'code'
          ? `код ${field}: sha256 ${String(got).slice(0, 12)}… (${actual.codeSizes?.[field] ?? '?'} байт) вместо ${String(want).slice(0, 12)}…`
          : `${group}.${field}: ${show(got)} вместо ${show(want)}`
      ;(diffs[group] ??= []).push(line)
    }
  }
  return diffs
}

function describeLog(log, names) {
  const event = EVENTS[log.topics?.[0]?.toLowerCase()]
  const contract = names[log.address.toLowerCase()] ?? log.address
  const parts = []
  if (event) {
    const data = log.data && log.data !== '0x' ? words(log.data) : []
    event.data.forEach((spec, i) => {
      const [kind, label] = spec.split(':')
      const word = data[i]
      if (word === undefined) return
      if (kind === 'address') parts.push(`${label}=${wordToAddress(word)}`)
      else if (kind === 'time') parts.push(`${label}=${new Date(Number(wordToBigInt(word)) * 1000).toISOString()}`)
      else parts.push(`${label}=${wordToBigInt(word)}`)
    })
    if (/Queued|Executed|Cancelled/.test(event.name) && log.topics[1]) parts.unshift(`id=${log.topics[1].slice(0, 18)}…`)
  }
  const name = event ? event.name : `topic ${log.topics?.[0]?.slice(0, 18)}…`
  return `блок ${BigInt(log.blockNumber)}: ${contract}.${name}${parts.length ? ` (${parts.join(', ')})` : ''}, tx ${log.transactionHash}`
}

/**
 * События управления за последние `windowBlocks` блоков — подробности к тревоге, а не её причина.
 * Причина всегда в состоянии: любая постановка в очередь таймлока требует транзакции Safe и сдвигает
 * его nonce, поэтому окно событий может быть коротким, не теряя ни одного изменения.
 */
export async function recentGovernanceEvents(rpc, contracts, toBlock, { windowBlocks, chunkBlocks }) {
  const names = Object.fromEntries(Object.entries(contracts).map(([name, address]) => [address.toLowerCase(), name]))
  const addresses = [contracts.safe, contracts.timelock, contracts.feeSwitch]
  const from = toBlock - BigInt(windowBlocks) + 1n
  const logs = []
  for (let start = from; start <= toBlock; start += BigInt(chunkBlocks)) {
    const end = start + BigInt(chunkBlocks) - 1n < toBlock ? start + BigInt(chunkBlocks) - 1n : toBlock
    logs.push(...(await rpc('eth_getLogs', [{ fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16), address: addresses }])))
  }
  return logs.filter((log) => log.topics?.[0]?.toLowerCase() !== SAFE_RECEIVED_TOPIC).map((log) => describeLog(log, names))
}

/**
 * Проверки цепи одним блоком: выбор узла, чтение, сравнение, подтверждение вторым узлом.
 *
 * Расхождение, которое второй живой узел НЕ подтвердил, — сбой узла, а не изменение управления:
 * оно уходит в сведения, не в тревогу. Если второго живого узла нет, расхождение идёт в тревогу с
 * пометкой «не подтверждено»: молчать об изменении управления из-за одного лежащего узла дороже,
 * чем один лишний сигнал.
 */
export async function checkChain(cfg, { makeRpc, now = () => new Date() }) {
  const base = cfg.base
  const results = []
  const usable = []
  const rejected = []
  for (const entry of base.rpcs) {
    const rpc = makeRpc(entry)
    try {
      usable.push({ rpc, head: await probeRpc(rpc, { chainId: base.chainId, maxBlockLagSeconds: base.maxBlockLagSeconds, now: now() }) })
    } catch (err) {
      rejected.push(describeError(err))
    }
  }

  let primary = null
  let actual = null
  const readErrors = []
  for (const candidate of usable) {
    try {
      actual = await readGovernance(candidate.rpc, base.contracts, '0x' + candidate.head.number.toString(16))
      primary = candidate
      break
    } catch (err) {
      readErrors.push(describeError(err))
    }
  }

  const rpcInfo = [
    primary ? `чтение: ${primary.rpc.host}, блок ${primary.head.number}` : null,
    ...rejected.map((e) => `отброшен ${e}`),
    ...readErrors.map((e) => `чтение не удалось: ${e}`),
  ].filter(Boolean)
  results.push({
    id: 'base.rpc',
    ok: primary !== null,
    detail: primary ? '' : 'ни один узел Base не дал прочитать управление — проверки цепи слепы',
    info: rpcInfo.join('; '),
  })
  if (!primary) return results

  const diffs = diffGovernance(actual, base.expected)
  let confirm = null
  if (Object.keys(diffs).length > 0) {
    for (const candidate of usable) {
      if (candidate === primary) continue
      try {
        const second = await readGovernance(candidate.rpc, base.contracts, '0x' + candidate.head.number.toString(16))
        confirm = { host: candidate.rpc.host, diffs: diffGovernance(second, base.expected) }
        break
      } catch {
        // следующий узел
      }
    }
  }

  // Узлы по-разному режут getLogs (publicnode отказывает на блоках старше суток), поэтому окно
  // событий читается первым узлом, который его отдаст, начиная с того, что читал состояние.
  let events = null
  if (Object.keys(diffs).length > 0) {
    const logErrors = []
    for (const candidate of [primary, ...usable.filter((c) => c !== primary)]) {
      try {
        events = await recentGovernanceEvents(candidate.rpc, base.contracts, primary.head.number, {
          windowBlocks: base.logWindowBlocks,
          chunkBlocks: base.logChunkBlocks,
        })
        break
      } catch (err) {
        logErrors.push(describeError(err))
      }
    }
    events ??= [`события прочитать не удалось: ${logErrors.join('; ')}`]
  }

  for (const group of GOVERNANCE_GROUPS) {
    const found = diffs[group]
    if (!found) {
      results.push({ id: `base.${group}`, ok: true, detail: '', info: summarize(group, actual, base.contracts) })
      continue
    }
    if (confirm && !confirm.diffs[group]) {
      results.push({
        id: `base.${group}`,
        ok: true,
        detail: '',
        info: `${primary.rpc.host} показал расхождение (${found.join('; ')}), ${confirm.host} — нет: сбой узла, не тревога`,
      })
      continue
    }
    const note = confirm ? `подтверждено ${confirm.host}` : 'второй узел для подтверждения недоступен'
    const eventsNote = !events
      ? ''
      : events.length
        ? ` События управления за последние ${base.logWindowBlocks} блоков (до ${MAX_EVENTS} последних): ${events.slice(-MAX_EVENTS).join(' | ')}`
        : ` Событий управления за последние ${base.logWindowBlocks} блоков нет.`
    results.push({ id: `base.${group}`, ok: false, detail: `${found.join('; ')} (${note}).${eventsNote}`, info: '' })
  }
  return results
}

const DISPLAY = { router: 'AggregatorRouter', feeSwitch: 'FeeSwitch', timelock: 'ParamTimelock', safe: 'Safe' }

/** Адрес именем контракта, если он один из наших. */
function label(address, contracts) {
  const hit = Object.entries(contracts).find(([, a]) => a.toLowerCase() === address.toLowerCase())
  return hit ? DISPLAY[hit[0]] ?? hit[0] : address
}

function summarize(group, actual, contracts) {
  switch (group) {
    case 'code':
      return Object.entries(actual.codeSizes).map(([name, size]) => `${name} ${size} байт`).join(', ')
    case 'router':
      return `feeSwitch() → ${label(actual.router.feeSwitch, contracts)}, swapRouter() → ${actual.router.swapRouter}`
    case 'feeSwitch':
      return `комиссия ${actual.feeSwitch.feeBps} bps, получатель ${label(actual.feeSwitch.feeCollector, contracts)}, владелец ${label(actual.feeSwitch.owner, contracts)}`
    case 'timelock':
      return `владелец ${label(actual.timelock.owner, contracts)}, привязан к ${label(actual.timelock.feeSwitch, contracts)}`
    case 'safe':
      return `владельцев ${actual.safe.owners.length}, порог ${actual.safe.threshold}, nonce ${actual.safe.nonce}, модулей ${actual.safe.modules.length}`
    default:
      return ''
  }
}
