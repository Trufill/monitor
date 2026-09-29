import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MODULES_PAGE_CALLDATA, codeSha256, decodeAddress, decodeAddressArray, decodeUint, words } from '../src/abi.mjs'

const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0')
const OWNER = '0xda37f17cfb086b9f4c730aeb7a205b04186a66a5'

test('адрес и целое читаются из одного слова', () => {
  assert.equal(decodeAddress('0x' + word(OWNER)), OWNER)
  assert.equal(decodeUint('0x' + word('1e')), 30n)
})

test('слово с мусором в старших байтах — не адрес', () => {
  assert.throws(() => decodeAddress('0x' + 'ff'.repeat(12) + OWNER.slice(2)), /не адрес/)
})

test('ответ не той длины отвергается, а не читается «как получится»', () => {
  assert.throws(() => decodeUint('0x' + word('1') + word('2')), /одно слово/)
  assert.throws(() => words('0x1234'), /не кратна 32/)
  assert.throws(() => words('0xzz'), /не hex/)
  assert.throws(() => decodeAddress('0x'), /одно слово/)
})

test('getOwners(): address[] с одним владельцем', () => {
  const hex = '0x' + word('20') + word('1') + word(OWNER)
  assert.deepEqual(decodeAddressArray(hex), [OWNER])
})

test('getModulesPaginated(): пустой массив и SENTINEL в хвосте', () => {
  // (address[] array, address next): голова [смещение массива, next], затем длина 0
  const hex = '0x' + word('40') + word('1') + word('0')
  assert.deepEqual(decodeAddressArray(hex), [])
})

test('массив, не помещающийся в ответ, — ошибка', () => {
  assert.throws(() => decodeAddressArray('0x' + word('20') + word('2') + word(OWNER)), /не помещается/)
})

test('calldata первой страницы модулей: селектор, SENTINEL, размер 10', () => {
  assert.equal(MODULES_PAGE_CALLDATA, '0xcc2f8452' + word('1') + word('a'))
})

test('sha256 кода: пустой код даёт хеш пустой строки, а не совпадение', () => {
  assert.equal(codeSha256('0x'), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})
