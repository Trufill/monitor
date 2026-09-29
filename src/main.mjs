import { appendFile, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { applyDecision, decide, makeGitHub } from './alert.mjs'
import { checkChain } from './chain.mjs'
import { describeError, httpGet, makeRpc, peerCertificate, withRetries } from './net.mjs'
import {
  evaluateCertificate,
  evaluateHealth,
  evaluatePage,
  evaluateSnapshot,
  evaluateStatus,
  evaluateSwap,
  mainBundleOf,
} from './web.mjs'

export const TITLES = {
  'api.status': 'Шлюз: /status',
  'api.health': 'Шлюз: /health',
  'swap.app': 'Терминал',
  'site.pages': 'Сайт',
  'accuracy.snapshot': 'Снимок точности',
  tls: 'TLS-сертификаты',
  'base.rpc': 'Узлы Base',
  'base.code': 'Код контрактов',
  'base.router': 'Роутер: связка',
  'base.feeSwitch': 'FeeSwitch',
  'base.timelock': 'Таймлок',
  'base.safe': 'Safe',
  drill: 'Учебная тревога',
}

export function hintsFor(cfg) {
  const { safe, timelock } = cfg.base.contracts
  const gateway =
    'Шлюз api.trufill.xyz: на сервере `systemctl status trufill-gateway` и `journalctl -u trufill-gateway -n 200`; откат — по ops/systemd/README.md в dex-aggregator.'
  const governance =
    `Изменилось управление на цепи. История Safe: https://app.safe.global/transactions/history?safe=base:${safe} · ` +
    `события таймлока: https://basescan.org/address/${timelock}#events. ` +
    'Если изменение твоё и ожидаемое — обнови `base.expected` в config.json: тревога закроется сама после двух чистых прогонов. ' +
    'Если не твоё — у таймлока 2 дня до исполнения любой постановки: отмени её через Safe (`cancel(id)`), пока ключ под контролем.'
  return {
    'api.status': gateway,
    'api.health': gateway,
    'swap.app': 'Терминал swap.trufill.xyz: сверить выкладку релиза; повторить `ops/deploy-swap.sh` или откатить на предыдущий релиз.',
    'site.pages': 'Сайт trufill.xyz: nginx и выкладка web:main.',
    'accuracy.snapshot':
      'Витрина точности: на сервере `systemctl status trufill-snapshot.service` и `journalctl -u trufill-snapshot -n 50` — там же отказ публикации по политике rc.',
    tls: 'Сертификаты: продлить на сервере (`certbot renew`) и `systemctl reload nginx`.',
    'base.rpc':
      'Публичные узлы Base недоступны с раннера GitHub — проверки управления слепы. Обычно проходит само; если держится — поменять `base.rpcs` в config.json.',
    'base.code': governance,
    'base.router': governance,
    'base.feeSwitch': governance,
    'base.timelock': governance,
    'base.safe': governance,
    drill: 'Учебная тревога, запущенная вручную: ничего делать не нужно, закроется сама после двух чистых прогонов.',
  }
}

/** Все проверки одного прогона. Сеть подменяется в тестах через `io`. */
export async function runChecks(cfg, io = {}) {
  const {
    now = () => new Date(),
    get = (url) => httpGet(url),
    rpcFactory = (entry) => makeRpc(entry.url, { paceMs: entry.paceMs }),
    cert = (host) => peerCertificate(host),
    retry = withRetries,
  } = io
  const http = cfg.http
  const tasks = {
    'api.status': async () => evaluateStatus(await get(http.status), { baseChainId: cfg.base.chainId }),
    'api.health': async () => evaluateHealth(await get(http.health)),
    'swap.app': async () => {
      const [page, version] = await Promise.all([get(http.swap), get(http.swapVersion)])
      const bundlePath = page.status === 200 ? mainBundleOf(page.text) : null
      const bundle = bundlePath ? await get(new URL(bundlePath, http.swap).href) : null
      return evaluateSwap({ page, version, bundle })
    },
    'site.pages': async () => {
      const [home, accuracy] = await Promise.all([get(http.site), get(http.accuracyPage)])
      const problems = [...evaluatePage('главная', home), ...evaluatePage('accuracy.html', accuracy)]
      return { ok: problems.length === 0, detail: problems.join('; '), info: 'главная и accuracy.html' }
    },
    'accuracy.snapshot': async () =>
      evaluateSnapshot(await get(http.accuracySnapshot), { now: now(), maxAgeMinutes: cfg.accuracy.maxAgeMinutes }),
    tls: async () => {
      const problems = []
      const info = []
      for (const host of cfg.tls.hosts) {
        try {
          const verdict = evaluateCertificate(host, await cert(host), { now: now(), minDaysLeft: cfg.tls.minDaysLeft })
          if (verdict.problem) problems.push(verdict.problem)
          info.push(verdict.info)
        } catch (err) {
          problems.push(describeError(err))
        }
      }
      return { ok: problems.length === 0, detail: problems.join('; '), info: info.join('; ') }
    },
  }
  const web = Object.entries(tasks).map(async ([id, run]) => ({ id, ...(await retry(run)) }))
  const chain = checkChain(cfg, { makeRpc: rpcFactory, now }).catch((err) => [
    { id: 'base.rpc', ok: false, detail: `проверка цепи упала: ${describeError(err)}`, info: '' },
  ])
  const hints = hintsFor(cfg)
  const results = (await Promise.all([...web, chain])).flat()
  return results.map((r) => ({ ...r, title: TITLES[r.id] ?? r.id, hint: hints[r.id] }))
}

export function drillResult(cfg) {
  return {
    id: 'drill',
    ok: false,
    title: TITLES.drill,
    detail: 'запущено вручную с drill — проверка того, что тревога доходит',
    info: '',
    hint: hintsFor(cfg).drill,
  }
}

function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function renderSummary(results, { now }) {
  const lines = [
    `## Мониторинг Trufill — ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    '| Проверка | Итог | Подробности |',
    '|---|---|---|',
  ]
  for (const r of results) {
    const text = r.ok ? r.info : [r.detail, r.info].filter(Boolean).join(' — ')
    const attempts = r.attempts > 1 ? ` (попыток: ${r.attempts})` : ''
    lines.push(`| \`${r.id}\` ${cell(r.title)} | ${r.ok ? 'OK' : 'СБОЙ'} | ${cell(text)}${attempts} |`)
  }
  return lines.join('\n') + '\n'
}

/** Команда аннотации GitHub: `%`, CR и LF в тексте экранируются, иначе сообщение обрежется. */
function annotation(level, title, message) {
  const escape = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  return `::${level} title=${escape(title).replace(/:/g, '%3A').replace(/,/g, '%2C')}::${escape(message)}`
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const dryRun = argv.includes('--dry-run')
  const drill = argv.includes('--drill') || env.MONITOR_DRILL === '1'
  const configArg = argv.find((a) => a.startsWith('--config='))
  const configPath = configArg ? configArg.slice('--config='.length) : new URL('../config.json', import.meta.url)
  const cfg = JSON.parse(await readFile(configPath, 'utf8'))

  // --no-retry — для ручной диагностики: заведомый сбой виден сразу, без трёх попыток за ~45 с.
  const retry = argv.includes('--no-retry') ? (run) => withRetries(run, { attempts: 1 }) : withRetries
  const results = await runChecks(cfg, { retry })
  if (drill) results.push(drillResult(cfg))
  const now = new Date()

  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'СБОЙ'}  ${r.id.padEnd(18)} ${r.ok ? r.info : r.detail}${r.attempts > 1 ? ` [попыток: ${r.attempts}]` : ''}`)
  }
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, renderSummary(results, { now }))
  const failures = results.filter((r) => !r.ok)
  if (env.GITHUB_ACTIONS === 'true') for (const f of failures) console.log(annotation('warning', f.id, f.detail))

  if (dryRun) {
    console.log(failures.length ? `dry-run: тревога открылась бы по ${failures.map((f) => f.id).join(', ')}` : 'dry-run: тревога не нужна')
    return failures.length ? 1 : 0
  }
  const token = env.GITHUB_TOKEN
  const repo = env.GITHUB_REPOSITORY
  if (!token || !repo) throw new Error('нужны GITHUB_TOKEN и GITHUB_REPOSITORY — или запуск с --dry-run')
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : null
  const github = makeGitHub({ token, repo })
  const issue = await github.findOpenAlert(cfg.alert.label)
  const decision = decide({ issue, failures, now, closeAfterOkRuns: cfg.alert.closeAfterOkRuns })
  console.log(await applyDecision(github, decision, { issue, failures, alertCfg: cfg.alert, runUrl, now }))
  // Сбой проверок не валит прогон: канал — issue. Красный прогон значит одно — сломан сам монитор,
  // и об этом GitHub пишет владельцу расписания отдельным письмом.
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      console.error(`монитор сломан: ${err.stack ?? err}`)
      process.exitCode = 2
    },
  )
}
