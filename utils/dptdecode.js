#!/usr/bin/env node
/*
 * dptdecode.js - decode payloads with knx 2.4.1's and KNXUltimate's dptlib,
 * the way hamon does (resolve the DPT id, then fromBuffer). Used by
 * dptcompare.py.
 *
 * stdin:  one JSON array per line: [dptid, hex]
 * stdout: one JSON array per line: [dptid, hex, knx, knxultimate]
 * A value is {"v": ...}, {"u": true} for undefined, or {"e": "message"} if
 * the decoder threw. Dates are ISO strings, Buffers hex.
 */
const readline = require('readline')
const knx = require('knx/src/dptlib')
const kxu = require('knxultimate/build/dptlib')

// both libraries log decode problems; keep stdout for results only
console.log = console.info = console.warn = console.debug = () => {}
for (const lib of [kxu]) {
    try { require('knxultimate/build/KnxLog').setLogLevel('error') } catch (e) { }
}

const resolved = new Map()
function resolve(lib, name, id) {
    const key = `${name}|${id}`
    if (!resolved.has(key)) {
        let dpt = null
        try { dpt = lib.resolve(id) } catch (e) { }
        resolved.set(key, dpt)
    }
    return resolved.get(key)
}

function plain(v) {
    if (v === undefined) return { u: true }
    if (v instanceof Date) return { v: isNaN(v) ? 'Invalid Date' : v.toISOString() }
    if (Buffer.isBuffer(v)) return { v: v.toString('hex') }
    return { v }
}

function decode(lib, name, id, buf) {
    const dpt = resolve(lib, name, id)
    if (dpt === null) return { e: 'unresolved' }
    try {
        return plain(lib.fromBuffer(buf, dpt))
    } catch (e) {
        return { e: String((e && e.message) || e).slice(0, 80) }
    }
}

const out = []
readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line) return
    const [id, hex] = JSON.parse(line)
    const buf = Buffer.from(hex, 'hex')
    out.push(JSON.stringify([id, hex, decode(knx, 'knx', id, buf), decode(kxu, 'kxu', id, buf)]))
    if (out.length >= 5000) { process.stdout.write(out.join('\n') + '\n'); out.length = 0 }
}).on('close', () => { if (out.length) process.stdout.write(out.join('\n') + '\n') })
