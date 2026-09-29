import { createHash } from 'node:crypto'
import { redactUrls } from './net.mjs'

function verdict(problems, info = []) {
  return { ok: problems.length === 0, detail: problems.join('; '), info: info.filter(Boolean).join('; ') }
}

function parseJson(text) {
  try {
    return { json: JSON.parse(text) }
  } catch {
    return { json: null }
  }
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds))
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3_600)
  const m = Math.floor((s % 3_600) / 60)
  if (d > 0) return `${d} д ${h} ч`
  if (h > 0) return `${h} ч ${m} мин`
  return `${m} мин`
}

/**
 * /status шлюза. Тревога — то, что бьёт по живым сделкам: Base не котируется (rpc или связка
 * роутера не `ok`), журнал котировок не пишется (`off` в проде — тоже сбой: котировки без записи
 * ровно то, что `/status` обязан показывать), или общий `down`. Тестнеты — только в сведения.
 */
export function evaluateStatus({ status, text }, { baseChainId }) {
  const { json } = parseJson(text)
  if (!json) return verdict([`HTTP ${status}, ответ не JSON`])
  // 503 с документом статуса — это `down` с подробностями; ответ без `chains` и `journal` — не
  // документ статуса вовсе (404 прокси, страница ошибки), и разбирать его поля — только шуметь.
  if (status !== 200 && json.chains === undefined && json.journal === undefined) {
    const error = json.error?.message ?? json.error?.code ?? json.error
    return verdict([`HTTP ${status}${typeof error === 'string' ? `: ${redactUrls(error)}` : ''}`])
  }
  const problems = []
  if (status !== 200) problems.push(`HTTP ${status}`)
  if (json.status === 'down') problems.push('общий статус down')
  const journal = json.journal
  if (journal?.status !== 'ok') {
    const why = [journal?.probeError, journal?.lastWriteError?.error].filter(Boolean).map(redactUrls).join(', ')
    problems.push(`журнал котировок: ${journal?.status ?? 'нет поля'}${why ? ` (${why})` : ''}`)
  }
  const lines = Array.isArray(json.chains?.lines) ? json.chains.lines : []
  const baseLine = lines.find((line) => line.id === baseChainId)
  if (!baseLine) problems.push(`нет строки Base ${baseChainId}`)
  else if (baseLine.rpc !== 'ok' || baseLine.routerWiring !== 'ok') {
    problems.push(`Base: rpc=${baseLine.rpc}, routerWiring=${baseLine.routerWiring}${baseLine.detail ? `, ${redactUrls(baseLine.detail)}` : ''}`)
  }
  const version = json.version
  const info = [
    `шлюз ${version?.sha ? version.sha.slice(0, 7) : '?'}${version?.dirty ? ' (собран из грязного дерева)' : ''}`,
    typeof json.uptimeSeconds === 'number' ? `аптайм ${formatDuration(json.uptimeSeconds)}` : null,
    ...lines
      .filter((line) => line.id !== baseChainId && (line.rpc !== 'ok' || line.routerWiring !== 'ok'))
      .map((line) => `тестнет ${line.id}: rpc=${line.rpc}, routerWiring=${line.routerWiring}`),
  ]
  return verdict(problems, info)
}

/** /health: 503 означает `down` — всё молчит или связка Base расходится с реестром. */
export function evaluateHealth({ status, text }) {
  const { json } = parseJson(text)
  const problems = []
  if (status !== 200) problems.push(`HTTP ${status}`)
  if (!json) problems.push('ответ не JSON')
  else if (json.status !== 'ok' && json.status !== 'degraded') problems.push(`status=${json.status}`)
  return verdict(problems, [json?.status ? `status=${json.status}` : null])
}

/** Путь главного бандла из index.html терминала: `assets/index-<хеш>.js`. */
export function mainBundleOf(html) {
  const match = html.match(/<script[^>]*\bsrc="\/?(assets\/index-[A-Za-z0-9_-]+\.js)"/)
  return match ? match[1] : null
}

/**
 * Терминал: страница отдаётся, её бандл тот же, что назван в version.json, и он скачивается.
 * Расхождение страницы и version.json — признак недовыложенного релиза: страница ссылается на
 * один бандл, а записанная версия — на другой.
 */
export function evaluateSwap({ page, version, bundle }) {
  const problems = []
  if (page.status !== 200 || !page.contentType.includes('text/html')) problems.push(`страница: HTTP ${page.status}, ${page.contentType || 'без типа'}`)
  const fromPage = page.status === 200 ? mainBundleOf(page.text) : null
  if (page.status === 200 && !fromPage) problems.push('в index.html нет главного бандла assets/index-*.js')
  const { json } = parseJson(version.text)
  if (version.status !== 200) problems.push(`version.json: HTTP ${version.status}`)
  else if (!json) problems.push('version.json: не JSON')
  else if (typeof json.build !== 'string') problems.push('version.json: нет поля build')
  else if (fromPage && json.build !== fromPage) problems.push(`version.json называет ${json.build}, а страница грузит ${fromPage}`)
  if (bundle) {
    if (bundle.status !== 200 || !bundle.contentType.includes('javascript')) problems.push(`бандл ${fromPage}: HTTP ${bundle.status}, ${bundle.contentType || 'без типа'}`)
    else if (bundle.text.length < 10_000) problems.push(`бандл ${fromPage}: подозрительно мал (${bundle.text.length} байт)`)
  }
  return verdict(problems, [fromPage ? `сборка ${fromPage}` : null])
}

/** Страница сайта: 200, HTML и заголовок с «Trufill» — заглушка nginx или чужая страница не пройдут. */
export function evaluatePage(name, { status, contentType, text }) {
  if (status !== 200) return [`${name}: HTTP ${status}`]
  if (!contentType.includes('text/html')) return [`${name}: тип ${contentType || 'не указан'}`]
  const title = text.match(/<title>([^<]*)<\/title>/)?.[1] ?? ''
  if (!title.includes('Trufill')) return [`${name}: заголовок «${title.slice(0, 60)}» без Trufill`]
  return []
}

/**
 * Хеш снимка по его же опубликованному рецепту `snapshotSha256Recipe`:
 *   sed -e 's/"snapshotSha256": "[0-9a-f]\{64\}"/…нули…/' -e 's/"generatedAt": "[0-9:.TZ-]\{24\}"/…/' | sha256sum
 * sed заменяет первое совпадение в каждой строке — здесь так же, построчно и без флага g.
 */
export function snapshotSha256(text) {
  const normalized = text
    .split('\n')
    .map((line) =>
      line
        .replace(/"snapshotSha256": "[0-9a-f]{64}"/, `"snapshotSha256": "${'0'.repeat(64)}"`)
        .replace(/"generatedAt": "[0-9:.TZ-]{24}"/, '"generatedAt": "0000-00-00T00:00:00.000Z"'),
    )
    .join('\n')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/**
 * Снимок точности: свежий (таймер пишет его раз в 15 минут), хеш сходится с рецептом, и нет ни
 * одного нарушения порога — порог защищён контрактом, так что нарушение значит поломку учёта или
 * исполнения. Недобор до обещанного при допуске 0.5 % на mainnet законен и идёт в сведения.
 */
export function evaluateSnapshot({ status, text }, { now, maxAgeMinutes }) {
  if (status !== 200) return verdict([`HTTP ${status}`])
  const { json } = parseJson(text)
  if (!json) return verdict(['ответ не JSON'])
  const problems = []
  const generatedAt = Date.parse(json.generatedAt)
  const ageMinutes = Number.isFinite(generatedAt) ? (now.getTime() - generatedAt) / 60_000 : NaN
  if (!Number.isFinite(ageMinutes)) problems.push(`generatedAt не читается: ${json.generatedAt}`)
  else if (ageMinutes > maxAgeMinutes) problems.push(`снимок не обновлялся ${formatDuration(ageMinutes * 60)} (порог ${maxAgeMinutes} мин)`)
  const expectedHash = json.snapshotSha256
  const actualHash = snapshotSha256(text)
  if (actualHash !== expectedHash) problems.push(`хеш по рецепту ${actualHash.slice(0, 12)}… не равен опубликованному ${String(expectedHash).slice(0, 12)}…`)
  const summary = json.summary ?? {}
  if (Number(summary.thresholdViolations ?? 0) > 0) problems.push(`нарушений порога: ${summary.thresholdViolations}`)
  const info = [
    Number.isFinite(ageMinutes) ? `возраст ${formatDuration(ageMinutes * 60)}` : null,
    `сделок ${summary.trades ?? '?'}, недоборов до обещанного ${summary.promiseShortfalls ?? '?'}`,
    Array.isArray(json.errata) && json.errata.length ? `опечаток ${json.errata.length}` : null,
  ]
  return verdict(problems, info)
}

/** Сертификат: не меньше `minDaysLeft` дней до конца. */
export function evaluateCertificate(host, { validTo, issuer }, { now, minDaysLeft }) {
  const daysLeft = (validTo.getTime() - now.getTime()) / 86_400_000
  const info = `${host}: до ${validTo.toISOString().slice(0, 10)} (${Math.floor(daysLeft)} дн., ${issuer})`
  return daysLeft < minDaysLeft ? { problem: `${host}: сертификат истекает через ${Math.floor(daysLeft)} дн. (${validTo.toISOString().slice(0, 10)})`, info } : { problem: null, info }
}
