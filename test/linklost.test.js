#!/usr/bin/env node
/*
 * linklost.test.js - a site's minute report (alive) and lost link (site.js):
 * a container site (dns 172.*) reports from its start and while its link is
 * down, so the silence ladder sees a dead VPN path; a direct site only while
 * its link is up. An error after 'connected' calls lost() once. Then
 * service.js and sitestate.js: linkLost noted, carried through starting/down,
 * cleared on connected, and named on the Silent line.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
{ const l = require('log-driver').logger; l.levels.forEach((v) => { l[v] = () => {} }) }
const stub = (m, exports) => { const file = require.resolve(`../src/${m}`); require.cache[file] = { id: file, filename: file, loaded: true, exports } }
stub('db', { writeEvents: () => {} })
stub('dbv2', { writeEventsv2: () => {}, setSurvey: () => {} })
stub('mqwrite', { MQTTconnect: () => null, mqdisconnect: () => {} })
// the KNX stack: hand the test the site's handlers
let handlers = null
const fakeStack = () => ({ Connection: (o) => { handlers = o.handlers; return { Disconnect: () => {}, on: () => {} } }, Datapoint: function () { return { on: () => {} } } })
fakeStack.effective = (site, dflt) => site || dflt || 'knx'
stub('knxstack', fakeStack)
const { createSite } = require('../src/site')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linklost-')) + '/'
fs.mkdirSync(dir + 'config')
fs.writeFileSync(dir + 'dptmappings.txt', '#\n')
fs.writeFileSync(dir + 'config/good.xml', '<?xml version="1.0" encoding="utf-8"?>\n<GroupAddress-Export xmlns="http://knx.org/xml/ga-export/01">\n' +
    '  <GroupRange Name="Main" RangeStart="1" RangeEnd="2047">\n    <GroupRange Name="Middle" RangeStart="1" RangeEnd="255">\n' +
    '      <GroupAddress Name="Light" Address="0/0/1" DPTs="DPST-1-1" />\n    </GroupRange>\n  </GroupRange>\n</GroupAddress-Export>\n')
fs.writeFileSync(dir + '.hamon-secrets.json', '{}')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let checks = 0
async function site(dns) {
    const seen = { alive: 0, lost: 0, connected: 0 }
    handlers = null
    const s = createSite({ name: 'site-a', dns, port: 3671, phyAddr: '1.1.250', logging: 'error', path: dir, influxver: 2, config: 'good.xml' },
        { stack: 'knxultimate', connectedBefore: true, failures: 0, aliveEvery: 20 },
        { connected: () => seen.connected++, alive: () => seen.alive++, lost: () => seen.lost++,
          stopped: () => {}, timeout: () => {}, error: (e) => { throw e }, gateway: () => {} })
    s.start()
    for (let i = 0; i < 50 && handlers == null; i++) await wait(5)
    return { s, seen }
}

;(async () => {
    // container site: reports before it connects, and after it loses the link
    let { s, seen } = await site('172.18.0.5')
    await wait(70)
    assert.ok(seen.alive >= 2, `container: alive before connecting (${seen.alive})`); checks++
    handlers.connected()
    handlers.error('Connection dead')
    handlers.error('Connection timeout')
    assert.strictEqual(seen.lost, 1, 'lost once, on the first error after connected'); checks++
    let n = seen.alive
    await wait(70)
    assert.ok(seen.alive >= n + 2, 'container: alive while the link is down'); checks++
    handlers.connected()
    handlers.error('Connection dead')
    assert.strictEqual(seen.lost, 2, 'lost again after a reconnect'); checks++
    await s.stop()

    // direct site: nothing until connected, nothing once the link is down
    ;({ s, seen } = await site('127.0.0.1'))
    await wait(70)
    assert.strictEqual(seen.alive, 0, 'direct: no alive before connecting'); checks++
    handlers.connected()
    await wait(70)
    assert.ok(seen.alive >= 2, 'direct: alive while up'); checks++
    handlers.error('Connection dead')
    n = seen.alive
    await wait(70)
    assert.strictEqual(seen.alive, n, 'direct: no alive while down'); checks++
    assert.strictEqual(seen.lost, 1); checks++
    await s.stop()

    // sitestate: linkLost carried until connected
    const { SiteState } = require('../src/sitestate')
    const st = new SiteState(path.join(dir, 'state.json'))
    st.set('c', 'connected'); st.note('c', { linkLost: '2026-11-10T04:01:28Z' })
    st.set('c', 'starting'); st.set('c', 'down')
    assert.strictEqual(st.get('c').linkLost, '2026-11-10T04:01:28Z', 'kept through starting/down'); checks++
    st.set('c', 'connected')
    assert.strictEqual(st.get('c').linkLost, undefined, 'cleared on connected'); checks++
    st.note('c', { linkLost: 'x' }); st.set('c', 'blocked', { reason: 'dns' })
    assert.strictEqual(st.get('c').linkLost, undefined, 'a hold drops it'); checks++

    // service.js: noted, and on the Silent line
    const svc = require('../src/service')._test
    const { Silence } = require('../src/silence')
    const t = { default: 5, cooldown: 20, cooldownMax: 240, grace: 1440, maxRestarts: 6, sites: {} }
    const state = new SiteState(path.join(dir, 's2.json'))
    state.set('box', 'connected'); delete state.sites.box.firstConnected
    svc.setSilence(new Silence({ thresholds: () => t }), { silence: 'report', locations: [{ name: 'box', dns: 'gw.example', enabled: true }] }, state)
    svc.linkLost('box')
    assert.ok(state.get('box').linkLost, 'linkLost noted'); checks++
    const out = []
    const log = console.log
    console.log = (l) => out.push(l)
    try {
        svc.alive('box', Date.now() - 6 * 60000) // last telegram 6 min ago
        await wait(10)
    } finally { console.log = log }
    assert.ok(/^Silent: box no data for 6m \(>= 5m\), link lost 0m ago, restart 1: re-init \(report only\)$/.test(out.pop()), 'Silent line names the lost link'); checks++

    fs.rmSync(dir, { recursive: true, force: true })
    console.log(`linklost: ${checks} checks passed`)
    process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
