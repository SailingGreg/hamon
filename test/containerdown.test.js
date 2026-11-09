#!/usr/bin/env node
/*
 * containerdown.test.js - a container site (dns 172.*) whose link keeps
 * failing (service.js downRetry): its container is restarted as it goes into
 * the back-off, then at each retry a step behind the usual ladder; held while
 * the uplink is down, capped at max_restarts, only logged in report mode,
 * and a direct site is untouched.
 */
const assert = require('assert')
{ const l = require('log-driver').logger; l.levels.forEach((v) => { l[v] = () => {} }) }
for (const [m, fns] of [['db', ['writeEvents']], ['dbv2', ['writeEventsv2', 'setSurvey']]]) {
    const file = require.resolve(`../src/${m}`)
    require.cache[file] = { id: file, filename: file, loaded: true, exports: Object.fromEntries(fns.map((f) => [f, () => {}])) }
}
const svc = require('../src/service')._test
const { Silence } = require('../src/silence')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const MIN = 60000
const t = { default: 20, cooldown: 20, cooldownMax: 240, grace: 1440, maxRestarts: 3, sites: {} }
let up = null
const sil = new Silence({ thresholds: () => t, uplink: () => up })

// docker: one running container at 172.18.0.30, named vpnbox
const calls = []
let failRestart = false
svc.setDocker((args, cb) => {
    calls.push(args.join(' '))
    if (args[0] === 'ps') return cb(null, 'abc\n')
    if (args[0] === 'inspect') return cb(null, '/vpnbox 172.18.0.30 \n')
    if (args[0] === 'restart') return cb(failRestart ? new Error('boom') : null, '')
    cb(new Error('?'))
})
svc.setContainerUp(5)
const restarted = []
svc.setRestartSite((n) => restarted.push(n))
const doc = (mode) => ({ silence: mode, locations: [
    { name: 'box', dns: '172.18.0.30', enabled: true },
    { name: 'box2', dns: '172.18.0.30', enabled: true },
    { name: 'gone', dns: '172.18.0.99', enabled: true },
    { name: 'direct', dns: 'gw.example', enabled: true }] })

const out = []
const log = console.log
console.log = (l) => out.push(l)
const reset = (name) => { svc.cancelPending(name); svc.downConnected(name); svc.failures[name] = 0; calls.length = 0; restarted.length = 0; out.length = 0 }
// the delay of the back-off timer requestRestart left, in minutes (null: none)
const pendingMins = (name) => svc.pending[name] == null ? null : svc.pending[name]._idleTimeout / MIN
const fail = (name, n) => { for (let i = 0; i < n; i++) svc.requestRestart(name) }
let checks = 0

;(async () => {
    try {
        // act: the 3 immediate retries, then the container restart at once
        svc.setSilence(sil, doc('act'), null)
        fail('box', 3)
        assert.deepStrictEqual([restarted.length, calls.length], [3, 0], 'first three: plain restarts'); checks++
        fail('box', 1)
        assert.strictEqual(pendingMins('box'), null, 'no back-off wait: the container goes now'); checks++
        await wait(30)
        assert.ok(calls.includes('restart vpnbox'), 'docker restart'); checks++
        assert.deepStrictEqual(restarted, ['box', 'box', 'box', 'box'], 'then the site, after the VPN wait'); checks++
        assert.ok(/^Back-off: box down, container restart 1: docker restart vpnbox$/.test(out.pop())); checks++
        // the ladder runs a step behind: 15, 30 ...
        fail('box', 1)
        assert.strictEqual(pendingMins('box'), 15, 'next retry 15 min'); checks++
        fail('box', 1)
        assert.strictEqual(pendingMins('box'), 30, 'then 30'); checks++
        // connected: logged, count cleared
        svc.failures.box = 6; svc.downRestarts.box = 2
        out.length = 0
        svc.downConnected('box')
        assert.ok(/^Back-off: box connected again after \d+m down, 2 container restart\(s\)$/.test(out.pop()), 'connected line'); checks++
        assert.strictEqual(svc.downRestarts.box, undefined); checks++
        reset('box')

        // a shared container restarted a moment ago: not again, the site waits for it
        await wait(5)
        fail('box2', 4)
        await wait(30)
        assert.ok(!calls.includes('restart vpnbox'), 'shared container: one restart a minute'); checks++
        assert.ok(/container restart 1: container vpnbox restarted already$/.test(out.pop())); checks++
        assert.deepStrictEqual(restarted.slice(3), ['box2'], 'site still restarted'); checks++
        reset('box2')

        // no container at the IP: retried at once, logged
        fail('gone', 4)
        await wait(20)
        assert.ok(/^Back-off: gone down, container restart 1: no container at 172\.18\.0\.99$/.test(out.pop())); checks++
        assert.strictEqual(restarted.filter((n) => n === 'gone').length, 4); checks++
        reset('gone')

        // uplink down: held, normal back-off
        up = 'netprobe: 4/5 lost'
        fail('gone', 4)
        assert.ok(/^Back-off: gone down, container restart held - uplink down \(netprobe: 4\/5 lost\)$/.test(out.pop())); checks++
        assert.strictEqual(pendingMins('gone'), 15, 'plain back-off'); checks++
        assert.strictEqual(svc.downRestarts.gone, undefined, 'not counted'); checks++
        up = null
        reset('gone')

        // max_restarts: then plain retries, logged once
        svc.downRestarts.gone = 3; svc.failures.gone = 3 // e.g. capped, then a kpipe restart
        svc.requestRestart('gone')
        assert.ok(/3 container restarts haven't helped - plain retries until it connects$/.test(out.pop())); checks++
        assert.strictEqual(pendingMins('gone'), 15, 'capped: plain back-off'); checks++
        svc.failures.gone = 3
        svc.requestRestart('gone')
        assert.strictEqual(out.filter((l) => /haven't helped/.test(l)).length, 0, 'logged once'); checks++
        reset('gone')

        // report: logged as it would happen, back-off unchanged, no docker restart
        svc.setSilence(sil, doc('report'), null)
        fail('gone', 4)
        await wait(20)
        assert.strictEqual(pendingMins('gone'), 15, 'report: the usual 15 min'); checks++
        assert.ok(/^Back-off: gone down, container restart 1: no container at 172\.18\.0\.99 \(report only\)$/.test(out.pop())); checks++
        fail('gone', 1)
        assert.strictEqual(pendingMins('gone'), 30, 'report: the usual 30 min'); checks++
        reset('gone')
        // report on a running container: would restart, doesn't
        svc.setDocker((args, cb) => {
            calls.push(args.join(' '))
            if (args[0] === 'ps') return cb(null, 'def\n')
            if (args[0] === 'inspect') return cb(null, '/otherbox 172.18.0.30 \n')
            cb(new Error('restart must not run in report mode'))
        })
        fail('box', 4)
        await wait(20)
        assert.ok(!calls.some((c) => c.startsWith('restart')), 'report: no docker restart'); checks++
        assert.ok(/^Back-off: box down, container restart 1: docker restart otherbox \(report only\)$/.test(out.pop())); checks++
        reset('box')

        // a direct site, and silence off: as before
        fail('direct', 4)
        assert.deepStrictEqual([out.length, calls.length, pendingMins('direct')], [0, 0, 15], 'direct site untouched'); checks++
        reset('direct')
        svc.setSilence(sil, doc('off'), null)
        fail('box', 4)
        assert.deepStrictEqual([out.length, calls.length, pendingMins('box')], [0, 0, 15], 'silence off: untouched'); checks++
        reset('box')
        for (const n of ['box', 'box2', 'gone', 'direct']) svc.cancelPending(n)
    } finally {
        console.log = log
    }
    console.log(`containerdown.test.js: ${checks} checks passed`)
})().catch((e) => { console.log = log; console.error(e); process.exit(1) })
