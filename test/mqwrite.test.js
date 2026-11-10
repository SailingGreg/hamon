#!/usr/bin/env node
/*
 * mqwrite.test.js - MQTT commands to a site (mqwrite.js): a Data Secure GA on
 * a plain tunnel refuses write, on/off and read (logged, no action written to
 * Influx); other GAs still write.
 */
const assert = require('assert')
const EventEmitter = require('events')
{ const l = require('log-driver').logger; l.levels.forEach((v) => { l[v] = () => {} }) }
const stub = (m, exports) => { const file = require.resolve(m); require.cache[file] = { id: file, filename: file, loaded: true, exports } }
const actions = []
stub('../src/db', { writeActions: () => {}, writeEvents: () => {} })
stub('../src/dbv2', { writeActionsv2: (...a) => actions.push(a), writeEventsv2: () => {} })
let client = null
stub('mqtt', { connect: () => { client = new EventEmitter(); client.subscribe = () => {}; return client } })
const { MQTTconnect } = require('../src/mqwrite')

const sent = []
const ga = (dpt) => ({ dpt, endpoint: { write: (v) => sent.push(['write', v]), read: () => sent.push(['read']) } })
const groupAddresses = { '5/1/42': ga('DPT1.002'), '1/1/1': ga('DPT1.001') }
const lines = []
const log = { info: () => {}, error: (...a) => lines.push(a), warn: () => {} }
MQTTconnect(groupAddresses, null, { name: 'sitea', influxver: 2 }, log, new Set(['5/1/42']))
const msg = (topic, m) => client.emit('message', topic, Buffer.from(m))

let checks = 0
for (const cmd of ['write', 'on', 'off', 'read']) msg(`knx/sitea/5/1/42/${cmd}`, 'true')
assert.deepStrictEqual(sent, [], 'secured GA: nothing sent'); checks++
assert.deepStrictEqual(actions, [], 'secured GA: no action logged'); checks++
assert.strictEqual(lines.length, 4, 'secured GA: one line per command'); checks++
assert.ok(/Data Secure GA/.test(lines[0][0]) && lines[0][1] === 'write' && lines[0][2] === '5/1/42', 'the line'); checks++
msg('knx/sitea/1/1/1/write', 'true')
assert.deepStrictEqual(sent, [['write', true]], 'plain GA: written'); checks++
assert.strictEqual(actions.length, 1, 'plain GA: action logged'); checks++
console.log(`mqwrite: ${checks} checks passed`)
process.exit(0)
