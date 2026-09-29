import tls from 'node:tls'

export const USER_AGENT = 'trufill-monitor (+https://github.com/Trufill/monitor)'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Сообщение об ошибке без адресов целиком: тревоги публичны, а строка `detail` приходит и от чужих
 * систем (шлюз пересказывает ошибки своих RPC). Ключ в пути URL не должен попасть в issue, поэтому
 * от любого URL остаётся только схема и хост.
 */
export function redactUrls(text) {
  return String(text).replace(/(https?:\/\/[^/\s"'<>)]+)[^\s"'<>)]*/g, '$1')
}

/** Понятная причина сетевой ошибки: у fetch полезное лежит в `cause`, а не в `message`. */
export function describeError(err) {
  const cause = err?.cause
  const parts = [err?.name === 'TimeoutError' ? 'таймаут' : err?.message ?? String(err)]
  if (cause?.code) parts.push(cause.code)
  else if (cause?.message) parts.push(cause.message)
  return redactUrls(parts.join(': '))
}

/** GET без исключений на коде ответа: коды 4xx/5xx — это данные для проверки, а не ошибка сети. */
export async function httpGet(url, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': USER_AGENT, 'cache-control': 'no-cache' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', text }
}

/**
 * Повтор проверки целиком: и сетевого запроса, и оценки ответа. Сбой, не переживший трёх попыток
 * за ~45 с, — уже не моргание; то, что прошло хотя бы раз, считается живым.
 */
export async function withRetries(run, { attempts = 3, delaysMs = [15_000, 30_000], wait = sleep } = {}) {
  let last
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await wait(delaysMs[Math.min(i - 1, delaysMs.length - 1)])
    try {
      last = await run()
    } catch (err) {
      last = { ok: false, detail: describeError(err) }
    }
    if (last.ok) return { ...last, attempts: i + 1 }
  }
  return { ...last, attempts }
}

/** Срок сертификата, отданного хостом. Недоверенный или просроченный сертификат — ошибка соединения. */
export function peerCertificate(host, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate()
      socket.end()
      if (!cert?.valid_to) return reject(new Error(`${host}: сертификат не получен`))
      resolve({ validTo: new Date(cert.valid_to), issuer: cert.issuer?.O ?? cert.issuer?.CN ?? '' })
    })
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error(`${host}: таймаут TLS`))
    })
    socket.on('error', (err) => reject(new Error(`${host}: ${err.code ?? err.message}`)))
  })
}

/**
 * Клиент JSON-RPC одного узла. Ошибка узла — исключение с его хостом в тексте.
 *
 * Публичные узлы режут частоту (mainnet.base.org отвечает 429 уже на двадцати подряд вызовах),
 * поэтому между вызовами выдерживается пауза, а на 429 — до двух повторов с ожиданием, прежде
 * чем признать узел непригодным и уйти на следующий.
 */
export function makeRpc(url, { timeoutMs = 10_000, fetchImpl = fetch, paceMs = 150, wait = sleep } = {}) {
  const host = new URL(url).host
  let id = 0
  const rpc = async (method, params = []) => {
    let res
    for (let attempt = 0; ; attempt++) {
      await wait(attempt === 0 ? paceMs : 2_000 * attempt)
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        throw new Error(`${host}: ${method}: ${describeError(err)}`)
      }
      if (res.status !== 429 || attempt >= 2) break
    }
    if (!res.ok) throw new Error(`${host}: ${method}: HTTP ${res.status}`)
    let body
    try {
      body = await res.json()
    } catch {
      throw new Error(`${host}: ${method}: ответ не JSON`)
    }
    if (body.error) throw new Error(`${host}: ${method}: ${redactUrls(body.error.message ?? JSON.stringify(body.error))}`)
    return body.result
  }
  rpc.host = host
  return rpc
}
