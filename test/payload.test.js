#!/usr/bin/env node
/*
 * payload.test.js - MQTT payload -> parsePayload -> Datapoint.write -> bytes,
 * for both decoders (knx.Datapoint and src/datapoint.js).
 *
 *   node test/payload.test.js
 *
 * Each case either sends the expected bytes with both decoders, or is
 * refused (parsePayload gives NaN, or write() throws) - never a wrong value.
 */
const assert = require('assert')
const { EventEmitter } = require('events')
{ const l = require('log-driver').logger; l.levels.forEach((v) => { l[v] = () => {} }) }
const knx = require('knx')
const { Datapoint } = require('../src/datapoint')
const { parsePayload } = require('../src/payload')
const { writeError } = require('../src/dptrange')

class FakeConn extends EventEmitter {
    constructor () { super(); this.sent = [] }
    write (ga, value, dptid, cb) {
        const apdu = {}
        require('knx/src/dptlib').populateAPDU(value, apdu, dptid)
        this.sent.push(Buffer.isBuffer(apdu.data) ? apdu.data.toString('hex') : `non-buffer ${apdu.data}`)
        if (cb) cb()
    }
    writeRaw (ga, buf, bitlength, cb) { this.sent.push(buf.toString('hex')); if (cb) cb() }
    read () {}
}

// what goes on the bus: hex, or 'refused'
function send (Impl, dpt, payload) {
    const value = parsePayload(dpt, payload)
    if (typeof value === 'number' && Number.isNaN(value)) return 'refused'
    if (writeError(dpt, value)) return 'refused'   // as mqwrite
    const c = new FakeConn()
    try { new Impl({ ga: '1/2/3', dpt: dpt || undefined }, c).write(value) } catch (e) { return 'refused' }
    return c.sent.length ? c.sent[0] : 'refused'
}

// [dpt, MQTT payload, expected bytes or 'refused']
const CASES = [
    ['DPT1.001', 'true', '01'], ['DPT1.001', 'on', '01'], ['DPT1.001', '1', '01'],
    ['DPT1.001', '0', '00'], ['DPT1.001', 'false', '00'], ['DPT1.001', 'off', '00'],
    ['DPT5.001', '50', '80'], ['DPT5.001', '100', 'ff'], ['DPT5.001', '0', '00'],
    ['DPT5.001', '101', 'refused'], ['DPT5.001', '-1', 'refused'], ['DPT5.001', 'abc', 'refused'],
    ['DPT5.010', '7', '07'], ['DPT5.010', '256', 'refused'],
    ['DPT7.001', '1000', '03e8'], ['DPT7.001', '-1', 'refused'],
    ['DPT9.001', '21.5', '0c33'], ['DPT9.001', '-5', '860c'], ['DPT9.001', '21,5', 'refused'],
    ['DPT9.001', '700000', 'refused'],
    ['DPT17.001', '5', '05'], ['DPT20.102', '1', '01'],
    ['DPT18.001', '5', '04'], ['DPT18.001', '1', '00'], ['DPT18.001', '64', '3f'],
    ['DPT18.001', '{"save_recall":1,"scenenumber":3}', '82'],
    ['DPT18.001', '0', 'refused'], ['DPT18.001', '65', 'refused'], ['DPT18.001', '', 'refused'],
    ['DPT18.001', 'abc', 'refused'],
    ['DPT3.007', '{"decr_incr":1,"data":3}', '0b'], ['DPT3.007', '3', 'refused'],
    ['DPT16.000', 'Hello', '48656c6c6f000000000000000000'],
    [undefined, '1', 'refused'], ['', 'on', 'refused'],
]

let n = 0
for (const [dpt, payload, want] of CASES) {
    const a = send(knx.Datapoint, dpt, payload)
    const b = send(Datapoint, dpt, payload)
    assert.strictEqual(a, want, `knx: ${dpt} ${JSON.stringify(payload)} sent ${a}, want ${want}`)
    assert.strictEqual(b, want, `knxultimate: ${dpt} ${JSON.stringify(payload)} sent ${b}, want ${want}`)
    n++
}
console.log(`payload: ${n} payloads send the same bytes (or are refused) with both decoders`)
