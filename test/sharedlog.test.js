#!/usr/bin/env node
/*
 * sharedlog.test.js - with every site in one thread, a line from one of
 * knxultimate's shared loggers (NPDU here) names the site whose packet it was
 * handling. Two sites, each with a fake gateway on localhost that accepts the
 * tunnel and then sends a truncated frame (L = 1 but no APCI byte).
 */
const assert = require('assert')
const dgram = require('dgram')
const { UltimateConnection } = require('../src/ultimate-shim')

const hex = (s) => Buffer.from(s.replace(/ /g, ''), 'hex')
const CONNECT_RESPONSE = hex('0610 0206 0014 07 00 08 01 7f000001 0e57 04 04 1101')
const TRUNCATED = hex('0610 0420 0014 04 07 00 00 2900 bce0 1105 0003 01 00')

function gateway() {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4')
        sock.on('message', (msg, rinfo) => {
            if (msg.readUInt16BE(2) !== 0x0205) return   // only CONNECT_REQUEST
            sock.send(CONNECT_RESPONSE, rinfo.port, rinfo.address)
            setTimeout(() => sock.send(TRUNCATED, rinfo.port, rinfo.address), 100)
        })
        sock.bind(0, '127.0.0.1', () => resolve(sock))
    })
}

// knxultimate's console transport writes errors to stderr
const lines = []
const write = process.stderr.write.bind(process.stderr)
process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk).replace(/\x1b\[[0-9;]*m/g, ''))
    return write(chunk, ...rest)
}

;(async () => {
    const gws = [await gateway(), await gateway()]
    const sites = ['site-a', 'site-b']
    const conns = sites.map((site, i) => new UltimateConnection({
        site, ipAddr: '127.0.0.1', ipPort: gws[i].address().port, handlers: { error() { } },
    }))
    await new Promise((r) => setTimeout(r, 3500))

    let checks = 0
    for (const site of sites) {
        const mine = lines.filter((l) => / NPDU: /.test(l) && l.includes(`[${site}]`))
        assert.ok(mine.length > 0, `an NPDU line labelled [${site}]`)
        checks++
    }
    const unlabelled = lines.filter((l) => / NPDU: /.test(l) && !/\[site-[ab]\]/.test(l))
    assert.deepStrictEqual(unlabelled, [], 'every NPDU line has a site')
    checks++
    // a client's own (setPrefix) lines aren't labelled twice
    assert.ok(!lines.some((l) => /SITE-[AB]: \[site-/.test(l)), 'no double label')
    checks++

    for (const c of conns) { c.closing = true; try { c.client.Disconnect() } catch (e) { } }
    for (const g of gws) g.close()
    console.log(`sharedlog: ${checks} checks passed`)
    setTimeout(() => process.exit(0), 200)
})().catch((e) => { console.error(e); process.exit(1) })
