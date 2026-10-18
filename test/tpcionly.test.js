#!/usr/bin/env node
/*
 * tpcionly.test.js - device-to-device frames (the T_Connect / T_ACK /
 * T_Disconnect of an ETS or visualisation device scan) parse without an
 * error and never reach hamon as group events; group frames still do.
 * Needs patches/knxultimate+6.2.0.patch (NPDU length 0 has no APCI byte).
 */
const assert = require('assert')
const LDataInd = require('knxultimate/build/protocol/cEMI/LDataInd').default
const { UltimateConnection } = require('../src/ultimate-shim')

// cEMI after the message code: addLen, ctrl1, ctrl2, src, dst, npduLen, tpci[, apci, data]
const P2P = [0x00, 0xb0, 0x60, 0x11, 0x65, 0x11, 0x97]     // 1.1.101 -> 1.1.151
const GROUP = [0x00, 0xbc, 0xe0, 0x11, 0x05, 0x00, 0x03]   // 1.1.5 -> 0/0/3
const frames = [
    ['T_Connect', [...P2P, 0x00, 0x80], null],
    ['T_Disconnect', [...P2P, 0x00, 0x81], null],
    ['T_ACK', [...P2P, 0x00, 0xc2], null],
    ['T_NAK', [...P2P, 0x00, 0xc3], null],
    ['A_DeviceDescriptor_Read', [...P2P, 0x01, 0x43, 0x00], null],
    ['GroupValue_Write', [...GROUP, 0x01, 0x00, 0x81], 'GroupValue_Write'],
    ['GroupValue_Response', [...GROUP, 0x01, 0x00, 0x40], 'GroupValue_Response'],
    ['GroupValue_Read', [...GROUP, 0x01, 0x00, 0x00], 'GroupValue_Read'],
]

// the parser's own error lines go through knxultimate's logger; count them
const logged = []
const KnxLog = require('knxultimate/build/KnxLog')
const npduLog = KnxLog.module('NPDU')
const origError = npduLog.error.bind(npduLog)
npduLog.error = (...a) => { logged.push(a.join(' ')); return origError(...a) }

let checks = 0
for (const [name, bytes, want] of frames) {
    const cemi = LDataInd.createFromBuffer(Buffer.from(bytes))
    assert.ok(cemi.npdu, `${name}: parsed`)
    const conn = Object.create(UltimateConnection.prototype)
    const events = []
    conn.emit = (e, evt) => { if (e === 'event') events.push(evt) }
    conn.indication({ cEMIMessage: cemi }, false)
    assert.deepStrictEqual(events, want ? [want] : [], `${name}: ${want || 'ignored'}`)
    checks++
}
assert.deepStrictEqual(logged, [], 'no parser errors')
checks++
console.log(`tpcionly: ${checks} checks passed`)
