#!/usr/bin/env node
/*
 * datapoint.test.js - src/datapoint.js (decoder: knxultimate) against
 * knx.Datapoint (decoder: knx) over a fake connection.
 *
 *   node test/datapoint.test.js
 *
 * Decoding: the value dbv2 would store must be the same for every payload of
 * every DPT hamon decodes to a number/boolean/string. Writing: valid values
 * must encode to the same bytes; out-of-range and composite-from-a-number
 * writes must throw rather than send.
 */
const assert = require('assert')
const { EventEmitter } = require('events')
{ const l = require('log-driver').logger; l.levels.forEach((v) => { l[v] = () => {} }) }
const knx = require('knx')
const { Datapoint } = require('../src/datapoint')

class FakeConn extends EventEmitter {
    constructor () { super(); this.sent = [] }
    write (ga, value, dptid, cb) {           // knx.Datapoint path: knx encodes
        const apdu = {}
        require('knx/src/dptlib').populateAPDU(value, apdu, dptid)
        this.sent.push(apdu.data.toString('hex')); if (cb) cb()
    }
    writeRaw (ga, buf, bitlength, cb) { this.sent.push(buf.toString('hex')); if (cb) cb() }
    read (ga, cb) { this.lastRead = cb }
}

// what dbv2 makes of a value (booleans 1/0, strings without NUL padding)
const stored = (v) => typeof v === 'boolean' ? (v ? 1 : 0)
    : typeof v === 'string' ? v.replace(/\u0000/g, '').trim() : v

// the DPTs whose values reach Influx (objects, DPT10/11 are skipped by dbv2)
const DPTS = ['DPT1.001', 'DPT1.002', 'DPT1.003', 'DPT1.005', 'DPT1.008', 'DPT1.009', 'DPT1.100',
    'DPT5.001', 'DPT5.003', 'DPT5.005', 'DPT5.010', 'DPT5.100', 'DPT6.010', 'DPT7.001', 'DPT7.005',
    'DPT7.007', 'DPT7.012', 'DPT8.001', 'DPT9.001', 'DPT9.002', 'DPT9.004', 'DPT9.007', 'DPT9.020',
    'DPT13.002', 'DPT13.100', 'DPT14.019', 'DPT14.056', 'DPT14.057', 'DPT16.000', 'DPT16.001',
    'DPT17.001', 'DPT20.007', 'DPT20.102', 'DPT20.105', 'DPT20.107']

let seed = 7
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
function payloads (bits) {
    if (bits <= 6) return [...Array(1 << bits).keys()].map((v) => Buffer.from([v]))
    const len = Math.ceil(bits / 8)
    if (len === 1) return [...Array(256).keys()].map((v) => Buffer.from([v]))
    if (len === 2) return [...Array(65536).keys()].map((v) => Buffer.from([v >> 8, v & 255]))
    return [...Array(3000)].map(() => Buffer.from([...Array(len)].map(() => Math.floor(rnd() * 256))))
}

// 1. decoding
let checked = 0
for (const dpt of DPTS) {
    const ca = new FakeConn(), cb = new FakeConn()
    const a = new knx.Datapoint({ ga: '1/2/3', dpt }, ca)
    const b = new Datapoint({ ga: '1/2/3', dpt }, cb)
    // DPT16: knx clears the top bit of each byte, KNXUltimate keeps it - the
    // same for ASCII text; for 16.001 (ISO-8859-1) knx is wrong (é -> i), and
    // dbv2 only stores text that parses as a number. Compare 7-bit payloads
    let bufs = payloads(a.dpt.basetype.bitlength)
    if (dpt.startsWith('DPT16')) bufs = bufs.map((x) => x.map((c) => c & 0x7f))
    for (const buf of bufs) {
        ca.emit('event_1/2/3', 'GroupValue_Write', '1.1.1', buf)
        cb.emit('event_1/2/3', 'GroupValue_Write', '1.1.1', buf)
        // DPT 9's invalid-data value: knx gives 670760.96, hamon stores nothing
        const invalid9 = dpt.startsWith('DPT9') && buf.length === 2 && buf.readUInt16BE(0) === 0x7fff
        assert.deepStrictEqual(stored(b.current_value), invalid9 ? stored(undefined) : stored(a.current_value),
            `${dpt} ${buf.toString('hex')}: knx ${a.current_value} knxultimate ${b.current_value}`)
        checked++
    }
}
console.log(`decode: ${checked} payloads over ${DPTS.length} DPTs store the same value`)

// 2. writing - valid values encode the same
const valid = { 'DPT1.001': [true, false], 'DPT5.001': [0, 1, 50, 99.6, 100], 'DPT5.010': [0, 7, 255],
    'DPT6.010': [-128, 0, 127], 'DPT7.001': [0, 1000, 65535], 'DPT9.001': [-20, 0, 21.5, 100],
    'DPT14.019': [-1.5, 0, 12345.678], 'DPT17.001': [0, 5, 63], 'DPT20.102': [0, 1, 4],
    'DPT16.000': ['Hello'], 'DPT18.001': [{ save_recall: 0, scenenumber: 5 }] }
let writes = 0
for (const [dpt, values] of Object.entries(valid)) {
    for (const v of values) {
        const ca = new FakeConn(), cb = new FakeConn()
        new knx.Datapoint({ ga: '1/2/3', dpt }, ca).write(v)
        const b = new Datapoint({ ga: '1/2/3', dpt }, cb)
        b.write(v)
        assert.deepStrictEqual(cb.sent, ca.sent, `${dpt} write ${JSON.stringify(v)}`)
        assert.deepStrictEqual(b.current_value, v, `${dpt} current_value after write`)
        writes++
    }
}
// ... and invalid ones are refused, not sent
const invalid = { 'DPT5.001': [101, 128, -1], 'DPT7.001': [-1, 65536], 'DPT6.010': [128, -129],
    'DPT9.001': [-274, 3.4e38], 'DPT18.001': [5], 'DPT2.001': [1], 'DPT19.001': [0], 'DPT3.007': [3] }
for (const [dpt, values] of Object.entries(invalid)) {
    for (const v of values) {
        const c = new FakeConn()
        assert.throws(() => new Datapoint({ ga: '1/2/3', dpt }, c).write(v), undefined, `${dpt} ${v} should throw`)
        assert.strictEqual(c.sent.length, 0, `${dpt} ${v} was sent`)
        writes++
    }
}
console.log(`write: ${writes} cases (valid encode as knx, invalid refused)`)

// 3. read decodes the response
{
    const c = new FakeConn()
    let got
    new Datapoint({ ga: '1/2/3', dpt: 'DPT9.001' }, c).read((src, v) => { got = v })
    c.lastRead('1.1.1', Buffer.from('0c1a', 'hex'))
    assert.strictEqual(got, 21)
    console.log('read: ok')
}

// 4. a telegram that can't be stored is reported, with why
{
    const cases = [
        ['DPT9.001', '7fff', /invalid data \(7FFFh\)/],
        ['DPT6.010', '0000', /doesn't fit DPT6\.010/],
        ['DPT9.001', '0c1a', null],
        ['DPT1.001', '01', null],
        [undefined, '0000', null],   // no DPT: decoded as 1.001, but not a device fault
    ]
    for (const [dpt, hex, want] of cases) {
        const c = new FakeConn()
        const reported = []
        const d = new Datapoint({ ga: '1/2/3', dpt }, c)
        d.on('invalid', (src, buf, reason) => reported.push([src, buf.toString('hex'), reason]))
        c.emit('event_1/2/3', 'GroupValue_Write', '1.1.77', Buffer.from(hex, 'hex'))
        if (want === null) {
            assert.deepStrictEqual(reported, [], `${dpt} ${hex} isn't reported`)
        } else {
            assert.strictEqual(reported.length, 1, `${dpt} ${hex} is reported`)
            assert.strictEqual(reported[0][0], '1.1.77', 'with the sender')
            assert.match(reported[0][2], want)
            assert.ok(d.current_value == null, `${dpt} ${hex} isn't stored`)
        }
    }
    console.log('invalid: ok')
}
