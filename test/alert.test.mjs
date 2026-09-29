import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyDecision, decide, makeGitHub, parseState, renderBody, renderTitle } from '../src/alert.mjs'

const T0 = new Date('2026-09-29T10:00:00Z')
const f = (id, detail = 'сбой') => ({ id, title: id, detail, hint: `что делать с ${id}` })
const issueWith = (state, number = 7) => ({ number, body: renderBody({ failures: [], state, runUrl: null, now: T0, closeAfterOkRuns: 2 }) })
const opts = { now: T0, closeAfterOkRuns: 2 }

test('состояние переживает круг через тело issue', () => {
  const state = { failing: ['api.status', 'base.safe'], okStreak: 1, since: T0.toISOString() }
  assert.deepEqual(parseState(issueWith(state).body), state)
  assert.equal(parseState('тело без метки'), null)
  assert.equal(parseState('<!-- trufill-monitor-state {"failing":"x"} -->'), null)
})

test('нет сбоев и нет тревоги — ничего не делать', () => {
  assert.deepEqual(decide({ issue: null, failures: [], ...opts }), { action: 'none' })
})

test('первый сбой — открыть тревогу', () => {
  const d = decide({ issue: null, failures: [f('base.safe'), f('api.status')], ...opts })
  assert.equal(d.action, 'create')
  assert.deepEqual(d.state, { failing: ['api.status', 'base.safe'], okStreak: 0, since: T0.toISOString() })
})

test('тот же состав — молча обновить тело, без комментария', () => {
  const issue = issueWith({ failing: ['api.status'], okStreak: 0, since: 'x' })
  const d = decide({ issue, failures: [f('api.status', 'другая деталь')], ...opts })
  assert.equal(d.action, 'update')
  assert.equal(d.comment, null)
  assert.equal(d.state.since, 'x')
})

test('состав изменился — комментарий с новыми и восстановившимися', () => {
  const issue = issueWith({ failing: ['api.status'], okStreak: 0, since: 'x' })
  const d = decide({ issue, failures: [f('base.safe')], ...opts })
  assert.equal(d.action, 'update')
  assert.match(d.comment, /Новые сбои: `base.safe`\. Восстановились: `api.status`\./)
})

test('первый чистый прогон — ещё не закрывать', () => {
  const d = decide({ issue: issueWith({ failing: ['api.status'], okStreak: 0, since: 'x' }), failures: [], ...opts })
  assert.equal(d.action, 'update')
  assert.equal(d.state.okStreak, 1)
  assert.equal(d.comment, null)
})

test('второй чистый прогон подряд — закрыть с комментарием', () => {
  const d = decide({ issue: issueWith({ failing: ['api.status'], okStreak: 1, since: 'x' }), failures: [], ...opts })
  assert.equal(d.action, 'close')
  assert.match(d.comment, /Тревога длилась с x по 2026-09-29T10:00:00.000Z/)
})

test('сбой вернулся посреди восстановления — счётчик в ноль, без комментария при том же составе', () => {
  const d = decide({ issue: issueWith({ failing: ['api.status'], okStreak: 1, since: 'x' }), failures: [f('api.status')], ...opts })
  assert.equal(d.action, 'update')
  assert.equal(d.state.okStreak, 0)
  assert.equal(d.comment, null)
})

test('тревога без метки состояния (правили руками) — считается пустой, не падает', () => {
  const d = decide({ issue: { number: 3, body: 'руками', created_at: '2026-09-01T00:00:00Z' }, failures: [f('tls')], ...opts })
  assert.equal(d.action, 'update')
  assert.match(d.comment, /Новые сбои: `tls`/)
  assert.equal(d.state.since, '2026-09-01T00:00:00Z')
})

test('заголовок: учебная тревога называется учебной', () => {
  assert.equal(renderTitle(['drill']), 'Учебная тревога мониторинга')
  assert.equal(renderTitle(['api.status', 'drill']), 'Тревога мониторинга: api.status, drill')
})

test('тело: таблица сбоев, подсказки без повторов, ссылка на прогон, метка состояния', () => {
  const state = { failing: ['base.fee', 'base.safe'], okStreak: 0, since: 's' }
  const body = renderBody({
    failures: [{ ...f('base.fee', 'a|b'), hint: 'одно' }, { ...f('base.safe'), hint: 'одно' }],
    state,
    runUrl: 'https://github.com/Trufill/monitor/actions/runs/1',
    now: T0,
    closeAfterOkRuns: 2,
  })
  assert.match(body, /\| `base.fee` base.fee \| a\\\|b \|/)
  assert.equal(body.match(/- одно/g).length, 1)
  assert.match(body, /\[журнал прогона\]\(https:\/\/github.com\/Trufill\/monitor\/actions\/runs\/1\)/)
  assert.deepEqual(parseState(body), state)
})

function fakeGitHub({ rejectAssignee = false } = {}) {
  const calls = []
  return {
    calls,
    async findOpenAlert() {
      return null
    },
    async createIssue(fields) {
      calls.push(['create', fields])
      if (rejectAssignee && fields.assignees) throw new Error('GitHub POST /repos/x/issues: HTTP 422: Validation Failed')
      return { number: 11, assignees: (fields.assignees ?? []).map((login) => ({ login })) }
    },
    async updateIssue(number, fields) {
      calls.push(['update', number, fields])
    },
    async comment(number, body) {
      calls.push(['comment', number, body])
    },
  }
}

const alertCfg = { label: 'monitor-alert', assignee: 'artemmalanin979-create', closeAfterOkRuns: 2 }

test('открытие: метка и назначенный', async () => {
  const gh = fakeGitHub()
  const failures = [f('api.status')]
  const decision = decide({ issue: null, failures, ...opts })
  const log = await applyDecision(gh, decision, { issue: null, failures, alertCfg, runUrl: null, now: T0 })
  assert.equal(log, 'открыта тревога #11')
  const [, fields] = gh.calls[0]
  assert.deepEqual(fields.labels, ['monitor-alert'])
  assert.deepEqual(fields.assignees, ['artemmalanin979-create'])
  assert.equal(fields.title, 'Тревога мониторинга: api.status')
})

test('назначение отвергнуто (422) — тревога всё равно открывается', async () => {
  const gh = fakeGitHub({ rejectAssignee: true })
  const failures = [f('api.status')]
  const log = await applyDecision(gh, decide({ issue: null, failures, ...opts }), { issue: null, failures, alertCfg, runUrl: null, now: T0 })
  assert.match(log, /открыта тревога #11 \(назначить artemmalanin979-create не удалось\)/)
  assert.equal(gh.calls.length, 2)
  assert.equal(gh.calls[1][1].assignees, undefined)
})

test('закрытие: сначала комментарий, потом state closed', async () => {
  const gh = fakeGitHub()
  const issue = issueWith({ failing: ['api.status'], okStreak: 1, since: 'x' })
  const log = await applyDecision(gh, decide({ issue, failures: [], ...opts }), { issue, failures: [], alertCfg, runUrl: null, now: T0 })
  assert.equal(log, 'тревога #7 закрыта')
  assert.equal(gh.calls[0][0], 'comment')
  assert.deepEqual(gh.calls[1][2].state, 'closed')
  assert.match(gh.calls[1][2].body, /тревога закрыта/)
})

test('клиент GitHub: повтор на 5xx, отказ на 4xx без повтора', async () => {
  const seen = []
  const responses = [
    { status: 502, body: {} },
    { status: 200, body: [{ number: 1, pull_request: {} }, { number: 2 }] },
  ]
  const fetchImpl = async (url, init) => {
    seen.push([init.method, url])
    const r = responses.shift()
    return { status: r.status, ok: r.status < 300, json: async () => r.body }
  }
  const gh = makeGitHub({ token: 't', repo: 'Trufill/monitor', fetchImpl, wait: async () => {} })
  assert.deepEqual(await gh.findOpenAlert('monitor-alert'), { number: 2 })
  assert.equal(seen.length, 2)
  assert.match(seen[0][1], /labels=monitor-alert/)

  const denied = makeGitHub({
    token: 't',
    repo: 'r',
    fetchImpl: async () => ({ status: 403, ok: false, json: async () => ({ message: 'Resource not accessible by integration' }) }),
    wait: async () => {},
  })
  await assert.rejects(denied.comment(1, 'x'), /HTTP 403: Resource not accessible by integration/)
})
