#!/usr/bin/env node
/*
 * unmapped.test.js - the shim marks whether a group value came in the APCI's
 * 6 bits or as data bytes (both arrive as a 1-byte Buffer), and
 * utils/unmapped.sh folds a GA's later "value N" lines into its first one.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const LDataInd = require('knxultimate/build/protocol/cEMI/LDataInd').default
const { UltimateConnection } = require('../src/ultimate-shim')

let checks = 0

// cEMI after the message code: addLen, ctrl1, ctrl2, src, dst, npduLen, tpci, apci[, data]
const GROUP = [0x00, 0xbc, 0xe0, 0x11, 0x05, 0x00, 0x03]   // 1.1.5 -> 0/0/3
const frames = [
    ['1-bit write', [...GROUP, 0x01, 0x00, 0x81], '01', true],
    ['4-bit write', [...GROUP, 0x01, 0x00, 0x89], '09', true],
    ['1-byte write', [...GROUP, 0x02, 0x00, 0x80, 0x01], '01', false],
    ['1-byte response', [...GROUP, 0x02, 0x00, 0x40, 0xcc], 'cc', false],
    ['2-byte write', [...GROUP, 0x03, 0x00, 0x80, 0x0c, 0x1a], '0c1a', false],
]
for (const [name, bytes, hex, sixBit] of frames) {
    const conn = Object.create(UltimateConnection.prototype)
    let got
    conn.emit = (e, evt, src, dest, data) => { if (e === 'event') got = data }
    conn.indication({ cEMIMessage: LDataInd.createFromBuffer(Buffer.from(bytes)) }, false)
    assert.strictEqual(got.toString('hex'), hex, `${name}: value`)
    assert.strictEqual(got.sixBit, sixBit, `${name}: sixBit ${sixBit}`)
    checks += 2
}

// unmapped.sh, run from a scratch directory with no dptmappings rules
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmapped-'))
fs.symlinkSync(path.join(__dirname, '../src'), path.join(dir, 'src'))
fs.writeFileSync(path.join(dir, 'dptmappings.txt'), '')
const tail = ' {"service":"hamon","site":"site-a"}'
fs.writeFileSync(path.join(dir, 'combined.log'), [
    'warn: UNMAPPED site-a 0/2/19 from 1.1.6: no DPT for "Hallway - Mode", payload 01 (1 byte)' + tail,
    'warn: UNMAPPED site-a 0/2/19 from 1.1.6: value 2 of up to 4, payload 03 (1 byte)' + tail,
    'warn: UNMAPPED site-a 0/1/5 from 1.1.7: not in the ETS export, payload 01' + tail,
    'warn: UNMAPPED site-a 0/2/19 from 1.1.6: value 3 of up to 4, payload 02 (1 byte)' + tail,
    'info: something else' + tail,
    'warn: UNMAPPED site-a 0/2/19 from 1.1.6: no DPT for "Hallway - Mode", payload 01 (1 byte)' + tail,
].join('\n') + '\n')
const out = execFileSync('bash', [path.join(__dirname, '../utils/unmapped.sh'), 'combined.log'], { cwd: dir })
    .toString().trim().split('\n').map((l) => l.replace(/ +/g, ' '))
fs.rmSync(dir, { recursive: true })
assert.deepStrictEqual(out, [
    'site-a 0/2/19 from 1.1.6 payload 01 (1 byte) 03 (1 byte) 02 (1 byte) no DPT for "Hallway - Mode"',
    'site-a 0/1/5 from 1.1.7 payload 01 not in the ETS export',
], 'unmapped.sh: one line per GA with its values')
checks++

console.log(`unmapped: ${checks} checks passed`)
