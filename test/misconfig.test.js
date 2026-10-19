#!/usr/bin/env node
/*
 * misconfig.test.js - a site whose config can't work (KNX Secure values
 * missing, GA file missing or empty) stops with reason 'config', before any
 * DNS lookup or tunnel, so service.js marks it misconfigured instead of
 * restarting it with back-off. A good config gets past the check (and stops
 * on its unresolvable DNS name instead).
 *
 *   node test/misconfig.test.js
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
{ const l = require('log-driver').logger; l.levels.forEach((v) => { l[v] = () => {} }) }
// the site stops before any write: stub the InfluxDB writers, which need src/.env
for (const [m, fns] of [['db', ['writeEvents']], ['dbv2', ['writeEventsv2']]]) {
    const file = require.resolve(`../src/${m}`)
    require.cache[file] = { id: file, filename: file, loaded: true, exports: Object.fromEntries(fns.map((f) => [f, () => {}])) }
}
const { createSite } = require('../src/site')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misconfig-')) + '/'
fs.mkdirSync(dir + 'config')
fs.writeFileSync(dir + 'dptmappings.txt', '#\n')
const GA = '<?xml version="1.0" encoding="utf-8"?>\n<GroupAddress-Export xmlns="http://knx.org/xml/ga-export/01">\n' +
    '  <GroupRange Name="Main" RangeStart="1" RangeEnd="2047">\n    <GroupRange Name="Middle" RangeStart="1" RangeEnd="255">\n' +
    '      <GroupAddress Name="Light" Address="0/0/1" DPTs="DPST-1-1" />\n    </GroupRange>\n  </GroupRange>\n</GroupAddress-Export>\n'
fs.writeFileSync(dir + 'config/good.xml', GA)
fs.writeFileSync(dir + 'config/empty.xml', '')
fs.writeFileSync(dir + '.hamon-secrets.json', '{}')

let checks = 0
// start a site and wait for the hook it ends with
function run(loc, stack = 'knxultimate') {
    return new Promise((resolve) => {
        const end = (hook) => (...args) => resolve({ hook, args })
        const site = createSite({ name: 'site-a', dns: 'gw.invalid', port: 3671, phyAddr: '1.1.250',
                                  logging: 'error', path: dir, influxver: 2, ...loc },
            { stack, connectedBefore: true, failures: 0 },
            { connected: end('connected'), stopped: end('stopped'), timeout: end('timeout'), error: end('error') })
        site.start()
    })
}
async function expect(loc, reason, detail, msg, stack) {
    const { hook, args } = await run(loc, stack)
    assert.deepStrictEqual([hook, args[0]], ['stopped', reason], `${msg}: got ${hook} ${args[0]} ${args[1]}`)
    assert.ok(String(args[1]).includes(detail), `${msg}: detail "${args[1]}" lacks "${detail}"`)
    checks++
}

;(async () => {
    await expect({ config: 'good.xml' }, 'dns', 'DNS lookup failed', 'good config: past the check, stops on DNS')
    await expect({ config: 'gone.xml' }, 'config', 'config/gone.xml not found', 'GA file missing')
    await expect({ config: undefined }, 'config', 'no config:', 'no config: entry')
    await expect({ config: 'empty.xml' }, 'config', 'no group addresses in config/empty.xml', 'GA file empty')
    await expect({ config: 'gone.knxproj' }, 'config', 'ENOENT', '.knxproj site without its .json')
    await expect({ config: 'good.xml', secure: true }, 'config', 'no secure values stored', 'secure, nothing uploaded')
    await expect({ config: 'good.xml', secure: true }, 'config', 'needs stack: knxultimate', 'secure on the knx stack', 'knx')
    // the device authentication code missing from the stored values
    fs.writeFileSync(dir + '.hamon-secrets.json', JSON.stringify({ 'site-a': { secure: {
        configFile: 'good.xml', gateway: '1.1.1', tunnels: { '1.1.2': { userId: 2, password: 'x' } }, groupKeys: {} } } }))
    await expect({ config: 'good.xml', secure: true, tunnelIA: '1.1.2' }, 'config', 'no device authentication code',
                 'secure without a device authentication code')
    fs.rmSync(dir, { recursive: true, force: true })
    console.log(`misconfig: ${checks} checks passed`)
    process.exit(0)
})().catch((e) => { console.error(e.message); process.exit(1) })
