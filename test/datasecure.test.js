#!/usr/bin/env node
/*
 * datasecure.test.js - Data Secure group telegrams on a plain tunnel
 * (datasecure.js, the shim and secrets.js). The secured frames were made by
 * XKNX (xknx.secure.data_secure, an independent implementation) from the
 * plain APDUs below with a test key - not any site's.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const LDataInd = require('knxultimate/build/protocol/cEMI/LDataInd').default
const { DataSecure, isSecured, gaNumber } = require('../src/datasecure')
const { UltimateConnection } = require('../src/ultimate-shim')
const { dataSecureKeys } = require('../src/secrets')

let checks = 0
const KEY = '000102030405060708090a0b0c0d0e0f'
const KEYS = { '5/0/1': KEY, '1/2/3': Buffer.from(KEY, 'hex').toString('base64') }   // hex and base64 both taken
const cemiOf = (hex) => LDataInd.createFromBuffer(Buffer.from(hex, 'hex').subarray(1))   // after the message code

// [name, secured L_Data.ind from XKNX, service, value, 6-bit]
const frames = [
    ['1-bit write true, 1.1.10 -> 5/0/1', '2900bce0110a28010e03f1100000000003e89444a18b6dac', 'write', '01', true],
    ['2-byte write, 1.1.10 -> 1/2/3', '29003ce0110a0a031003f1100000000003e9944aa05c25614c63', 'write', '0c1a', false],
    ['1-byte response, 1.1.11 -> 1/2/3', '2900bce0110b0a030f03f1100000000003eac44cdcfccb7b75', 'response', '80', false],
]

assert.strictEqual(gaNumber('5/0/1'), (5 << 11) | 1)
assert.strictEqual(gaNumber('1/2/3'), (1 << 11) | (2 << 8) | 3)
checks += 2

// decrypted in place to the plain APDU
let ds = new DataSecure(KEYS)
for (const [name, hex, service, value, sixBit] of frames) {
    const c = cemiOf(hex)
    assert.ok(isSecured(c), `${name}: seen as S-A_Data`)
    assert.strictEqual(ds.open(c), 'decrypted', `${name}: decrypts`)
    assert.strictEqual(c.npdu.isGroupWrite ? 'write' : c.npdu.isGroupResponse ? 'response' : '?', service, `${name}: service`)
    assert.strictEqual(c.npdu.dataValue.toString('hex'), value, `${name}: value`)
    assert.strictEqual(c.npdu.dataBuffer == null, sixBit, `${name}: 6-bit`)
    checks += 5
}

// a plain telegram is left alone
const plain = cemiOf('2900bce0110a28010100' + '81')
assert.ok(!isSecured(plain))
assert.strictEqual(ds.open(plain), 'plain')
checks += 2

// replay: the same frame again (equal SeqNr) is dropped; each sender has its own
assert.deepStrictEqual(ds.open(cemiOf(frames[0][1])), { drop: 'replay' }, 'same SeqNr again')
assert.deepStrictEqual(ds.open(cemiOf(frames[1][1])), { drop: 'replay' }, 'an older SeqNr')
checks += 2
// a fresh listener takes the first from each sender, whatever its number
ds = new DataSecure(KEYS)
assert.strictEqual(ds.open(cemiOf(frames[2][1])), 'decrypted', 'first from 1.1.11')
assert.strictEqual(ds.open(cemiOf(frames[1][1])), 'decrypted', 'first from 1.1.10, a lower SeqNr than the other sender')
checks += 2

// tampering: a changed byte in the ciphertext, the MAC or the source fails the MAC
const flip = (hex, at) => { const b = Buffer.from(hex, 'hex'); b[at] ^= 0x01; return b.toString('hex') }
const f1 = frames[1][1], len = f1.length / 2
for (const [what, at] of [['ciphertext', len - 6], ['MAC', len - 1], ['source address', 5], ['SeqNr', 16]]) {
    assert.deepStrictEqual(new DataSecure(KEYS).open(cemiOf(flip(f1, at))), { drop: 'MAC' }, `changed ${what}`)
    checks++
}
// the wrong key, and no key for the GA
assert.deepStrictEqual(new DataSecure({ '1/2/3': 'ffffffffffffffffffffffffffffffff' }).open(cemiOf(f1)), { drop: 'MAC' }, 'wrong key')
assert.deepStrictEqual(new DataSecure({ '5/0/1': KEY }).open(cemiOf(f1)), { drop: 'no key' }, 'no key for 1/2/3')
checks += 2

// through the shim: decrypted telegrams come out as ordinary events; without
// a key a DATASECURE line is logged (first, then every 100th) and nothing emitted
function shim(dataSecure) {
    const conn = Object.create(UltimateConnection.prototype)
    conn.options = { site: 'site-a' }
    conn.lines = []
    conn.log = { warn: (...a) => conn.lines.push(a), info: () => {}, error: () => {} }
    conn.events = []
    conn.emit = (e, ...a) => { if (e === 'event') conn.events.push(a) }
    if (dataSecure) conn.dataSecure = new DataSecure(dataSecure)
    return conn
}
let conn = shim(KEYS)
for (const [, hex] of frames) conn.indication({ cEMIMessage: cemiOf(hex) }, false)
assert.deepStrictEqual(conn.events.map(([evt, src, dest, data]) => [evt, src, dest, data.toString('hex')]), [
    ['GroupValue_Write', '1.1.10', '5/0/1', '01'],
    ['GroupValue_Write', '1.1.10', '1/2/3', '0c1a'],
    ['GroupValue_Response', '1.1.11', '1/2/3', '80'],
], 'shim: decrypted events')
assert.strictEqual(conn.lines.length, 0, 'shim: nothing logged')
checks += 2
conn = shim(undefined)
for (let i = 0; i < 100; i++) conn.indication({ cEMIMessage: cemiOf(frames[0][1]) }, false)
assert.strictEqual(conn.events.length, 0, 'shim, no key: nothing emitted')
assert.strictEqual(conn.lines.length, 2, 'shim, no key: logged first and 100th')
assert.ok(/DATASECURE/.test(conn.lines[0][0]) && conn.lines[0].includes('5/0/1') && /no key/.test(conn.lines[0][4]), 'shim, no key: the line')
checks += 3

// secrets.js: keys for a plain-tunnel site, checked against its GA file
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'datasecure-')) + '/'
fs.writeFileSync(dir + '.hamon-secrets.json', JSON.stringify({ 'site-a': { secure: { configFile: 'a.xml', groupKeys: KEYS } },
                                                               'site-b': { secure: { configFile: 'b.xml', groupKeys: {} } } }))
assert.deepStrictEqual(dataSecureKeys(dir, { name: 'site-a', config: 'a.xml' }), KEYS)
assert.strictEqual(dataSecureKeys(dir, { name: 'site-b', config: 'b.xml' }), undefined, 'no keys')
assert.strictEqual(dataSecureKeys(dir, { name: 'site-c', config: 'c.xml' }), undefined, 'no entry')
assert.throws(() => dataSecureKeys(dir, { name: 'site-a', config: 'other.xml' }), /re-upload the ETS project/)
fs.rmSync(dir, { recursive: true })
checks += 4

console.log(`datasecure: ${checks} checks passed`)
