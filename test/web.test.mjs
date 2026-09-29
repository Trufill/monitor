import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  evaluateCertificate,
  evaluateHealth,
  evaluatePage,
  evaluateSnapshot,
  evaluateStatus,
  evaluateSwap,
  mainBundleOf,
  snapshotSha256,
} from '../src/web.mjs'

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const STATUS = JSON.parse(fixture('status.json'))
const SNAPSHOT_TEXT = fixture('accuracy-snapshot.json')
const SWAP_HTML = fixture('swap-index.html')
const opts = { baseChainId: 8453 }

function statusWith(mutate) {
  const doc = structuredClone(STATUS)
  mutate(doc)
  return { status: 200, text: JSON.stringify(doc) }
}

test('/status с продакшна 2026-09-29 — зелёный', () => {
  const v = evaluateStatus({ status: 200, text: JSON.stringify(STATUS) }, opts)
  assert.equal(v.ok, true, v.detail)
  assert.match(v.info, /шлюз aaef6d9/)
})

test('Base: rpc=fail — тревога с пересказом detail', () => {
  const v = evaluateStatus(statusWith((d) => Object.assign(d.chains.lines[0], { rpc: 'fail', detail: 'timeout' })), opts)
  assert.equal(v.ok, false)
  assert.match(v.detail, /Base: rpc=fail, routerWiring=ok, timeout/)
})

test('Base: связка роутера mismatch — тревога', () => {
  const v = evaluateStatus(statusWith((d) => Object.assign(d.chains.lines[0], { routerWiring: 'mismatch' })), opts)
  assert.equal(v.ok, false)
  assert.match(v.detail, /routerWiring=mismatch/)
})

test('журнал котировок fail или off — тревога: котировки без записи не «ok»', () => {
  for (const status of ['fail', 'off']) {
    const v = evaluateStatus(
      statusWith((d) => Object.assign(d.journal, { status, probeError: status === 'fail' ? 'EACCES' : null })),
      opts,
    )
    assert.equal(v.ok, false, status)
    assert.match(v.detail, new RegExp(`журнал котировок: ${status}`))
  }
})

test('сбой тестнета — не тревога, а сведения', () => {
  const v = evaluateStatus(statusWith((d) => Object.assign(d.chains.lines[2], { rpc: 'fail' })), opts)
  assert.equal(v.ok, true)
  assert.match(v.info, /тестнет 421614: rpc=fail/)
})

test('нет строки Base — тревога', () => {
  const v = evaluateStatus(statusWith((d) => d.chains.lines.splice(0, 1)), opts)
  assert.equal(v.ok, false)
  assert.match(v.detail, /нет строки Base 8453/)
})

test('503 с документом статуса — down с подробностями', () => {
  const doc = structuredClone(STATUS)
  doc.status = 'down'
  doc.chains.lines[0].routerWiring = 'mismatch'
  const v = evaluateStatus({ status: 503, text: JSON.stringify(doc) }, opts)
  assert.equal(v.ok, false)
  assert.match(v.detail, /HTTP 503; общий статус down; .*routerWiring=mismatch/)
})

test('404 с JSON-ошибкой — только код и сообщение, без шума о полях', () => {
  const text = JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } })
  assert.deepEqual(evaluateStatus({ status: 404, text }, opts), { ok: false, detail: 'HTTP 404: Unknown endpoint.', info: '' })
})

test('не JSON — тревога', () => {
  assert.equal(evaluateStatus({ status: 502, text: '<html>Bad Gateway</html>' }, opts).detail, 'HTTP 502, ответ не JSON')
})

test('ключ в URL из detail шлюза не попадает в тревогу', () => {
  const v = evaluateStatus(
    statusWith((d) => Object.assign(d.chains.lines[0], { rpc: 'fail', detail: 'https://base.example/v2/SECRETKEY123 timed out' })),
    opts,
  )
  assert.doesNotMatch(v.detail, /SECRETKEY123/)
  assert.match(v.detail, /https:\/\/base\.example timed out/)
})

test('/health: 200 ok или degraded — живой, 503 — тревога', () => {
  assert.equal(evaluateHealth({ status: 200, text: '{"status":"ok"}' }).ok, true)
  assert.equal(evaluateHealth({ status: 200, text: '{"status":"degraded"}' }).ok, true)
  assert.equal(evaluateHealth({ status: 503, text: '{"status":"degraded"}' }).ok, false)
  assert.equal(evaluateHealth({ status: 200, text: 'nope' }).ok, false)
})

const page = { status: 200, contentType: 'text/html', text: SWAP_HTML }
const version = { status: 200, contentType: 'application/json', text: '{"build":"assets/index-ByOIFFuC.js"}' }
const bundle = { status: 200, contentType: 'application/javascript', text: 'x'.repeat(20_000) }

test('главный бандл терминала находится в index.html', () => {
  assert.equal(mainBundleOf(SWAP_HTML), 'assets/index-ByOIFFuC.js')
})

test('терминал: страница, version.json и бандл согласованы', () => {
  assert.equal(evaluateSwap({ page, version, bundle }).ok, true)
})

test('терминал: version.json называет другой бандл — недовыложенный релиз', () => {
  const v = evaluateSwap({ page, version: { ...version, text: '{"build":"assets/index-OTHER.js"}' }, bundle })
  assert.equal(v.ok, false)
  assert.match(v.detail, /version.json называет assets\/index-OTHER.js, а страница грузит assets\/index-ByOIFFuC.js/)
})

test('терминал: бандл не скачивается или пуст', () => {
  assert.match(evaluateSwap({ page, version, bundle: { status: 404, contentType: 'text/html', text: '' } }).detail, /HTTP 404/)
  assert.match(evaluateSwap({ page, version, bundle: { ...bundle, text: 'x' } }).detail, /подозрительно мал/)
})

test('терминал: 502 страницы и version.json без build', () => {
  const v = evaluateSwap({ page: { status: 502, contentType: 'text/html', text: '' }, version: { ...version, text: '{}' }, bundle: null })
  assert.match(v.detail, /страница: HTTP 502/)
  assert.match(v.detail, /нет поля build/)
})

test('страница сайта: без Trufill в заголовке — не наша страница', () => {
  assert.deepEqual(evaluatePage('главная', { status: 200, contentType: 'text/html', text: '<title>Trufill — обмен</title>' }), [])
  assert.match(evaluatePage('главная', { status: 200, contentType: 'text/html', text: '<title>Welcome to nginx!</title>' })[0], /без Trufill/)
  assert.match(evaluatePage('главная', { status: 500, contentType: 'text/html', text: '' })[0], /HTTP 500/)
})

test('хеш снимка по опубликованному рецепту совпадает с опубликованным', () => {
  const published = JSON.parse(SNAPSHOT_TEXT).snapshotSha256
  assert.equal(snapshotSha256(SNAPSHOT_TEXT), published)
})

const generatedAt = Date.parse(JSON.parse(SNAPSHOT_TEXT).generatedAt)
const snapshotOpts = (minutes) => ({ now: new Date(generatedAt + minutes * 60_000), maxAgeMinutes: 50 })

test('снимок свежий и целый — зелёный', () => {
  const v = evaluateSnapshot({ status: 200, text: SNAPSHOT_TEXT }, snapshotOpts(10))
  assert.equal(v.ok, true, v.detail)
  assert.match(v.info, /сделок 2/)
})

test('снимок старше порога — тревога', () => {
  const v = evaluateSnapshot({ status: 200, text: SNAPSHOT_TEXT }, snapshotOpts(51))
  assert.equal(v.ok, false)
  assert.match(v.detail, /не обновлялся 51 мин/)
})

test('правка тела снимка ломает хеш', () => {
  const tampered = SNAPSHOT_TEXT.replace('"attempts": 82', '"attempts": 83')
  assert.notEqual(tampered, SNAPSHOT_TEXT)
  assert.match(evaluateSnapshot({ status: 200, text: tampered }, snapshotOpts(10)).detail, /хеш по рецепту/)
})

test('нарушение порога — тревога, недобор до обещанного — нет', () => {
  const doc = JSON.parse(SNAPSHOT_TEXT)
  doc.summary.promiseShortfalls = 3
  const shortfall = evaluateSnapshot({ status: 200, text: JSON.stringify(doc, null, 2) + '\n' }, snapshotOpts(10))
  assert.doesNotMatch(shortfall.detail, /нарушений порога/)
  assert.match(shortfall.info, /недоборов до обещанного 3/)
  doc.summary.thresholdViolations = 1
  const violation = evaluateSnapshot({ status: 200, text: JSON.stringify(doc, null, 2) + '\n' }, snapshotOpts(10))
  assert.match(violation.detail, /нарушений порога: 1/)
})

test('сертификат: меньше порога дней — тревога', () => {
  const now = new Date('2026-09-29T00:00:00Z')
  const opts2 = { now, minDaysLeft: 14 }
  assert.equal(evaluateCertificate('a', { validTo: new Date('2026-12-07T00:00:00Z'), issuer: 'LE' }, opts2).problem, null)
  assert.match(evaluateCertificate('a', { validTo: new Date('2026-10-05T00:00:00Z'), issuer: 'LE' }, opts2).problem, /истекает через 6 дн/)
})
