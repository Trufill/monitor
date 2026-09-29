import { describeError, sleep } from './net.mjs'

/**
 * Тревога — одна открытая issue с меткой из config.json. Её состояние (что сбоит, сколько чистых
 * прогонов подряд) хранится в самой issue, в скрытом комментарии тела: у расписания GitHub нет
 * памяти между прогонами, а заводить ради двух чисел хранилище — лишняя движущаяся часть.
 *
 * Шумоподавление:
 *   - открытие — с первого прогона, в котором сбой пережил повторы внутри прогона;
 *   - пока состав сбоев тот же, тело правится молча (правка тела не шлёт уведомлений);
 *   - изменился состав — комментарий, он уведомляет;
 *   - закрытие — только после `closeAfterOkRuns` чистых прогонов подряд, чтобы моргающий сбой
 *     не открывал и не закрывал тревогу каждые пятнадцать минут.
 */

const STATE_RE = /<!-- trufill-monitor-state (\{.*?\}) -->/s

export function parseState(body) {
  const match = typeof body === 'string' ? body.match(STATE_RE) : null
  if (!match) return null
  try {
    const state = JSON.parse(match[1])
    return Array.isArray(state.failing) && Number.isInteger(state.okStreak) ? state : null
  } catch {
    return null
  }
}

function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function renderTitle(failing) {
  return failing.length === 1 && failing[0] === 'drill'
    ? 'Учебная тревога мониторинга'
    : `Тревога мониторинга: ${failing.join(', ')}`
}

export function renderBody({ failures, state, runUrl, now, closeAfterOkRuns }) {
  const lines = []
  if (failures.length > 0) {
    lines.push('| Проверка | Что не так |', '|---|---|')
    for (const f of failures) lines.push(`| \`${f.id}\` ${cell(f.title)} | ${cell(f.detail)} |`)
    const hints = [...new Set(failures.map((f) => f.hint).filter(Boolean))]
    if (hints.length) lines.push('', '**Что делать**', '', ...hints.map((h) => `- ${h}`))
  } else {
    lines.push(
      state.okStreak >= closeAfterOkRuns
        ? `Все проверки проходят ${state.okStreak} прогона подряд — тревога закрыта.`
        : `Последний прогон чистый: ${state.okStreak} из ${closeAfterOkRuns} подряд, после чего тревога закроется сама.`,
      '',
      `Сбоило: ${state.failing.map((id) => `\`${id}\``).join(', ')}.`,
    )
  }
  lines.push(
    '',
    `Открыта: ${state.since} · последний прогон: ${now.toISOString()}${runUrl ? ` · [журнал прогона](${runUrl})` : ''}`,
    '',
    `<!-- trufill-monitor-state ${JSON.stringify(state)} -->`,
  )
  return lines.join('\n')
}

/**
 * Чистое решение: что сделать с тревогой по итогам прогона. Ничего не вызывает — только говорит,
 * поэтому все ветки проверяются тестами без сети.
 */
export function decide({ issue, failures, now, closeAfterOkRuns }) {
  const failing = [...new Set(failures.map((f) => f.id))].sort()
  const nowIso = now.toISOString()
  if (!issue) {
    if (failing.length === 0) return { action: 'none' }
    return { action: 'create', state: { failing, okStreak: 0, since: nowIso } }
  }
  const previous = parseState(issue.body) ?? { failing: [], okStreak: 0, since: issue.created_at ?? nowIso }
  if (failing.length > 0) {
    const added = failing.filter((id) => !previous.failing.includes(id))
    const resolved = previous.failing.filter((id) => !failing.includes(id))
    const changes = [
      added.length ? `Новые сбои: ${added.map((id) => `\`${id}\``).join(', ')}.` : null,
      resolved.length ? `Восстановились: ${resolved.map((id) => `\`${id}\``).join(', ')}.` : null,
    ].filter(Boolean)
    return {
      action: 'update',
      state: { failing, okStreak: 0, since: previous.since },
      comment: changes.length ? changes.join(' ') : null,
    }
  }
  const okStreak = previous.okStreak + 1
  const state = { failing: previous.failing, okStreak, since: previous.since }
  if (okStreak >= closeAfterOkRuns) {
    return {
      action: 'close',
      state,
      comment: `Все проверки проходят ${okStreak} прогона подряд — закрываю. Тревога длилась с ${previous.since} по ${nowIso}.`,
    }
  }
  return { action: 'update', state, comment: null }
}

/** Клиент REST API GitHub с повтором на 5xx и сетевых сбоях. */
export function makeGitHub({ token, repo, apiUrl = 'https://api.github.com', fetchImpl = fetch, wait = sleep }) {
  async function api(method, path, body) {
    let lastError
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await wait(5_000 * attempt)
      let res
      try {
        res = await fetchImpl(`${apiUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'content-type': 'application/json',
            'user-agent': 'trufill-monitor',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        })
      } catch (err) {
        lastError = new Error(`GitHub ${method} ${path}: ${describeError(err)}`)
        continue
      }
      if (res.status >= 500) {
        lastError = new Error(`GitHub ${method} ${path}: HTTP ${res.status}`)
        continue
      }
      const data = res.status === 204 ? null : await res.json()
      if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status}: ${data?.message ?? ''}`)
      return data
    }
    throw lastError
  }
  return {
    async findOpenAlert(label) {
      const issues = await api('GET', `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&sort=created&direction=asc&per_page=20`)
      return issues.find((issue) => !issue.pull_request) ?? null
    },
    createIssue: (fields) => api('POST', `/repos/${repo}/issues`, fields),
    updateIssue: (number, fields) => api('PATCH', `/repos/${repo}/issues/${number}`, fields),
    comment: (number, body) => api('POST', `/repos/${repo}/issues/${number}/comments`, { body }),
  }
}

/** Исполняет решение `decide`. Возвращает строку для журнала прогона. */
export async function applyDecision(github, decision, { issue, failures, alertCfg, runUrl, now }) {
  const body = () => renderBody({ failures, state: decision.state, runUrl, now, closeAfterOkRuns: alertCfg.closeAfterOkRuns })
  switch (decision.action) {
    case 'none':
      return 'тревоги нет и не нужна'
    case 'create': {
      const fields = { title: renderTitle(decision.state.failing), body: body(), labels: [alertCfg.label] }
      let created
      try {
        created = await github.createIssue({ ...fields, assignees: [alertCfg.assignee] })
      } catch (err) {
        // 422 — назначение отвергнуто (например, у логина нет доступа к репозиторию). Тревога без
        // назначенного всё равно дойдёт до наблюдающих за репозиторием; молча не открыть её хуже.
        if (!/HTTP 422/.test(err.message)) throw err
        created = await github.createIssue(fields)
      }
      const assigned = (created.assignees ?? []).some((a) => a.login === alertCfg.assignee)
      return `открыта тревога #${created.number}${assigned ? '' : ` (назначить ${alertCfg.assignee} не удалось)`}`
    }
    case 'update': {
      const fields = { body: body() }
      if (failures.length > 0) fields.title = renderTitle(decision.state.failing)
      await github.updateIssue(issue.number, fields)
      if (decision.comment) await github.comment(issue.number, decision.comment)
      return `тревога #${issue.number} обновлена${decision.comment ? ' с комментарием' : ''}`
    }
    case 'close':
      await github.comment(issue.number, decision.comment)
      await github.updateIssue(issue.number, { body: body(), state: 'closed', state_reason: 'completed' })
      return `тревога #${issue.number} закрыта`
    default:
      throw new Error(`неизвестное решение ${decision.action}`)
  }
}
