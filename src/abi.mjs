import { createHash } from 'node:crypto'

/**
 * Ровно то из ABI, что нужно монитору, — без зависимостей.
 *
 * Селекторы и топики посчитаны `cast sig` / `cast keccak` (Foundry) по сигнатурам из исходников
 * контрактов и Safe 1.4.1. Проверяются они живым прогоном: неверный селектор вернул бы revert или
 * мусор, и декодер ниже отказал бы, а не выдал правдоподобное число.
 */
export const SEL = {
  feeSwitch: '0x88916b5b',
  swapRouter: '0xc31c9c07',
  owner: '0x8da5cb5b',
  pendingOwner: '0xe30c3978',
  feeBps: '0x24a9d853',
  feeCollector: '0xc415b95c',
  getOwners: '0xa0e67e2b',
  getThreshold: '0xe75235b8',
  nonce: '0xaffed0e0',
  getModulesPaginated: '0xcc2f8452',
}

/** getModulesPaginated(SENTINEL, 10): первая страница модулей Safe. */
export const MODULES_PAGE_CALLDATA =
  SEL.getModulesPaginated + '1'.padStart(64, '0') + (10).toString(16).padStart(64, '0')

/** Слоты хранилища Safe 1.4.1, которые не отдаются геттерами. */
export const SAFE_SLOTS = {
  singleton: '0x0',
  guard: '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8', // keccak256("guard_manager.guard.address")
  fallbackHandler: '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5', // keccak256("fallback_manager.handler.address")
}

/** ETH, пришедший на Safe, — не действие управления; остальные события трёх контрактов — действие. */
export const SAFE_RECEIVED_TOPIC = '0x3d0ce9bfc3ed7d6862dbb28b2dea94561fe714a1b4d019aa8af39730d1ad7c3d'

/** Имена событий для подробностей тревоги. `data` — порядок неиндексированных полей. */
export const EVENTS = {
  '0x4dac892ca3f8073fc4fa78fdc9d3da74945afe0f465d97f3196ae9ba9eaab450': { name: 'Queued', data: ['uint:newFeeBps', 'time:readyAt'] },
  '0x5fd4d8538e8d106158d3ae0865d1fffac053df46e63ec0fd53341436f65831b9': { name: 'FeeCollectorQueued', data: ['address:newCollector', 'time:readyAt'] },
  '0xafb34f25d2c1319cbd3f415e7ca4d37c4adba9fd49da12b21764bbae9b94dd99': { name: 'OwnershipTransferQueued', data: ['address:newOwner', 'time:readyAt'] },
  '0xa4bc355b6a64fa94872862b5f51149ed3750f1990bb6c5424ec8b209adef1f4b': { name: 'Executed', data: ['uint:newFeeBps'] },
  '0x6a9ab84fad812f9e8fe5edbfb28e7702a40455e452a0c50910eee4ca3a7da2f9': { name: 'FeeCollectorExecuted', data: ['address:newCollector'] },
  '0x493994c54b448f330ff7bdd0831434b0cb44b81300d031da098fe769211916d4': { name: 'OwnershipTransferExecuted', data: ['address:newOwner'] },
  '0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70': { name: 'Cancelled', data: [] },
  '0xa8b47b68e76971a050015c7327172dea6fefe574ffe7c911d94ea7850c4fe5a1': { name: 'FeeSwitchNominationRevoked', data: [] },
  '0xd231cfcc9bc90c0eba54a8abae16f164c4d1ae79efecea2b9b88e31fc14f20f9': { name: 'FeeSwitchBound', data: [] },
  '0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700': { name: 'OwnershipTransferStarted', data: [] },
  '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0': { name: 'OwnershipTransferred', data: [] },
  '0x4791562d259a08c64fef49ff6bef502e6c8f342eb8d4c8f90da367929ab1602d': { name: 'FeeBpsSet', data: ['uint:oldBps', 'uint:newBps'] },
  '0x089588e3f10370c99a6f74177eacb5361ba90e1b70a123bfeccb6619c21cd721': { name: 'FeeCollectorSet', data: ['address:oldCollector', 'address:newCollector'] },
  '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e': { name: 'ExecutionSuccess', data: [] },
  '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23': { name: 'ExecutionFailure', data: [] },
  '0x66753cd2356569ee081232e3be8909b950e0a76c1f8460c3a5e3c2be32b11bed': { name: 'SafeMultiSigTransaction', data: [] },
  '0x9465fa0c962cc76958e6373a993326400c1c94f8be2fe3a952adfa7f60b2ea26': { name: 'AddedOwner', data: [] },
  '0xf8d49fc529812e9a7c5c50e69c20f0dccc0db8fa95c98bc58cc9a4f1c1299eaf': { name: 'RemovedOwner', data: [] },
  '0x610f7ff2b304ae8903c3de74c60c6ab1f7d6226b3f52c5161905bb5ad4039c93': { name: 'ChangedThreshold', data: ['uint:threshold'] },
  '0xecdf3a3effea5783a3c4c2140e677577666428d44ed9d474a0b3a4c9943f8440': { name: 'EnabledModule', data: [] },
  '0xaab4fa2b463f581b2b32cb3b7e3b704b9ce37cc209b5fb4d77e593ace4054276': { name: 'DisabledModule', data: [] },
  '0x1151116914515bc0891ff9047a6cb32cf902546f83066499bcf8ba33d2353fa2': { name: 'ChangedGuard', data: [] },
  '0x5ac6c46c93c8d0e53714ba3b53db3e7c046da994313d7ed0d192028bc7c228b0': { name: 'ChangedFallbackHandler', data: [] },
  '0x6895c13664aa4f67288b25d7a21d7aaa34916e355fb9b6fae0a139a9085becb8': { name: 'ExecutionFromModuleSuccess', data: [] },
  '0xacd2c8702804128fdb0db2bb49f6d127dd0181c13fd45dbfe16de0930e2bd375': { name: 'ExecutionFromModuleFailure', data: [] },
  '0xb648d3644f584ed1c2232d53c46d87e693586486ad0d1175f8656013110b714e': { name: 'SafeModuleTransaction', data: [] },
  '0xf2a0eb156472d1440255b0d7c1e19cc07115d1051fe605b0dce69acfec884d9c': { name: 'ApproveHash', data: [] },
  '0xe7f4675038f4f6034dfcbbb24c4dc08e4ebf10eb9d257d3d02c0f38d122ac6e4': { name: 'SignMsg', data: [] },
}

function strip0x(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex)) throw new Error(`не hex: ${String(hex).slice(0, 80)}`)
  return hex.slice(2)
}

/** ABI-ответ по 32-байтным словам. Длина не кратна слову — ответ битый, а не «пустой». */
export function words(hex) {
  const body = strip0x(hex)
  if (body.length % 64 !== 0) throw new Error(`длина ответа ${body.length / 2} байт не кратна 32`)
  return body.match(/.{64}/g) ?? []
}

export function wordToAddress(word) {
  if (!/^0{24}/.test(word)) throw new Error(`в слове не адрес: 0x${word}`)
  return '0x' + word.slice(24).toLowerCase()
}

export function wordToBigInt(word) {
  return BigInt('0x' + word)
}

/** Ответ функции, возвращающей ровно один адрес (или слот хранилища с адресом). */
export function decodeAddress(hex) {
  const w = words(hex)
  if (w.length !== 1) throw new Error(`ожидалось одно слово, пришло ${w.length}`)
  return wordToAddress(w[0])
}

/** Ответ функции, возвращающей ровно одно целое. */
export function decodeUint(hex) {
  const w = words(hex)
  if (w.length !== 1) throw new Error(`ожидалось одно слово, пришло ${w.length}`)
  return wordToBigInt(w[0])
}

/** address[] из головы ответа: `headIndex` — номер слова со смещением массива. */
export function decodeAddressArray(hex, headIndex = 0) {
  const w = words(hex)
  const offsetBytes = wordToBigInt(w[headIndex] ?? '')
  if (offsetBytes % 32n !== 0n) throw new Error(`смещение массива ${offsetBytes} не кратно 32`)
  const at = Number(offsetBytes / 32n)
  if (at >= w.length) throw new Error('смещение массива за концом ответа')
  const length = Number(wordToBigInt(w[at]))
  if (at + 1 + length > w.length) throw new Error(`массив длиной ${length} не помещается в ответ`)
  return w.slice(at + 1, at + 1 + length).map(wordToAddress)
}

/** sha256 байтов кода: для сравнения с закреплённым значением keccak не нужен. */
export function codeSha256(hex) {
  return createHash('sha256').update(Buffer.from(strip0x(hex), 'hex')).digest('hex')
}

export function codeSize(hex) {
  return strip0x(hex).length / 2
}
