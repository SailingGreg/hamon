#!/usr/bin/env node
/*
 * knxdesc.test.js - the DESCRIPTION check connection.js makes before the
 * tunnel for a site that hasn't connected recently, against fake gateways on
 * localhost: one that answers, one that never does, one that answers with the
 * wrong service, and one that only answers the second request.
 */
const assert = require('assert')
const dgram = require('dgram')
const { describe, REQUEST } = require('../src/knxdesc')

// a DESCRIPTION_RESPONSE header (the DIBs don't matter to the check)
const RESPONSE = Buffer.from('061002040008' + '0000', 'hex')
const CONNECT_RESPONSE = Buffer.from('061002060008' + '0000', 'hex')

function gateway(reply) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4')
        sock.requests = 0
        sock.on('message', (msg, rinfo) => {
            sock.requests++
            assert.ok(msg.equals(REQUEST), 'the request is a DESCRIPTION_REQUEST with the NAT HPAI')
            const out = reply(sock.requests)
            if (out) sock.send(out, rinfo.port, rinfo.address)  // to the packet's source (NAT HPAI)
        })
        sock.bind(0, '127.0.0.1', () => resolve(sock))
    })
}

;(async () => {
    const quick = { timeout: 300, tries: 2 }
    let checks = 0

    const up = await gateway(() => RESPONSE)
    assert.strictEqual(await describe('127.0.0.1', up.address().port, quick), true, 'answering gateway')
    assert.strictEqual(up.requests, 1, 'one request is enough when it answers')
    checks += 2

    const silent = await gateway(() => null)
    const t0 = Date.now()
    assert.strictEqual(await describe('127.0.0.1', silent.address().port, quick), false, 'silent gateway')
    assert.strictEqual(silent.requests, 2, 'tries twice')
    assert.ok(Date.now() - t0 >= 550, 'waits out both timeouts')
    checks += 3

    const wrong = await gateway(() => CONNECT_RESPONSE)
    assert.strictEqual(await describe('127.0.0.1', wrong.address().port, quick), false, 'wrong service is not an answer')
    checks++

    const late = await gateway((n) => n === 2 ? RESPONSE : null)
    assert.strictEqual(await describe('127.0.0.1', late.address().port, quick), true, 'answers the second try')
    checks++

    // port given as a string, as it can come from hamon.yml
    assert.strictEqual(await describe('127.0.0.1', String(up.address().port), quick), true, 'string port')
    checks++

    for (const s of [up, silent, wrong, late]) s.close()
    console.log(`knxdesc: ${checks} checks passed`)
})().catch((e) => { console.error(e); process.exit(1) })
