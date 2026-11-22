#!/usr/bin/env node
/*
 * logstream.test.js - knxultimate writes every log line to its exported
 * logStream too. hamon never reads it, so the shim sets it flowing: lines
 * are dropped instead of kept for the life of the process, and a listener
 * added later still gets new lines.
 */
const assert = require('assert')
const dgram = require('dgram')
const { UltimateConnection } = require('../src/ultimate-shim')
const KnxLog = require('knxultimate/build/KnxLog')

;(async () => {
    // a gateway that never answers: the client only has to be created
    const gw = dgram.createSocket('udp4')
    await new Promise((r) => gw.bind(0, '127.0.0.1', r))
    const conn = new UltimateConnection({
        site: 'site-a', ipAddr: '127.0.0.1', ipPort: gw.address().port, handlers: { error() { } },
    })

    const log = KnxLog.module('LOGSTREAMTEST')
    for (const t of log.transports) if (t.name === 'console') t.silent = true
    const N = 2000
    for (let i = 0; i < N; i++) log.warn('line %d', i)
    await new Promise((r) => setImmediate(r))

    let checks = 0
    const { logStream } = KnxLog
    assert.strictEqual(logStream.writableLength, 0, 'nothing held on the write side')
    checks++
    assert.strictEqual(logStream.readableLength, 0, 'nothing held on the read side')
    checks++

    let got = 0
    logStream.on('data', () => got++)
    log.warn('late')
    await new Promise((r) => setImmediate(r))
    assert.strictEqual(got, 1, 'a late listener gets new lines, not the backlog')
    checks++

    conn.closing = true
    try { conn.client.Disconnect() } catch (e) { }
    gw.close()
    console.log(`logstream: ${checks} checks passed`)
    setTimeout(() => process.exit(0), 200)
})().catch((err) => { console.error(err); process.exit(1) })
