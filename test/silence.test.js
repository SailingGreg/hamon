#!/usr/bin/env node
/*
 * silence.test.js - a connected site that sends nothing (silence.js): the
 * thresholds file, the restart ladder (at once, then cooldown 2x ... max), the
 * spell ending on data, the uplink hold keeping the spell, and the uplink rule
 * read from netprobe's log (uplink.js), replayed on the 2026-11-04 outage.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Silence, loadThresholds, cooldown, mode } = require('../src/silence')
const { uplinkDown } = require('../src/uplink')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-'))
const conf = path.join(dir, 'freshness-thresholds.conf')
fs.writeFileSync(conf, '# comment\ndefault 20\ncooldown 20\ncooldown_max 240\ngrace 1440\nquietsite 720  # sparse\nbad x\n')

// thresholds file
const t = loadThresholds(conf)
assert.deepStrictEqual(t, { default: 20, cooldown: 20, cooldownMax: 240, sites: { quietsite: 720 } })
assert.strictEqual(loadThresholds(path.join(dir, 'none')), null)
fs.writeFileSync(path.join(dir, 'partial'), 'default 20\n')
assert.strictEqual(loadThresholds(path.join(dir, 'partial')), null, 'missing reserved keys: no thresholds')
assert.deepStrictEqual([1, 2, 3, 4, 5, 9].map((n) => cooldown(t, n)), [20, 40, 80, 160, 240, 240])

// mode flag
assert.strictEqual(mode({}), 'off')
assert.strictEqual(mode({ silence: 'report' }), 'report')
assert.strictEqual(mode({ silence: 'act' }), 'act')
assert.strictEqual(mode({ silence: true }), 'off', 'only the three words')
assert.strictEqual(mode(null), 'off')

// the ladder, on a fake clock
const MIN = 60000
let now = 0
let up = null
const s = new Silence({ thresholds: () => t, uplink: () => up, now: () => now })
const at = (m, last) => { now = m * MIN; return s.check('site', last * MIN) }

assert.strictEqual(at(19, 0).do, null, 'under the threshold')
let r = at(20, 0)
assert.deepStrictEqual([r.do, r.n, r.age, r.thresh], ['restart', 1, 20, 20], 'restart at once')
assert.strictEqual(at(25, 0).do, 'wait')
assert.strictEqual(at(39, 0).do, 'wait', 'cooldown 20 min')
r = at(40, 0)
assert.deepStrictEqual([r.do, r.n], ['restart', 2])
assert.strictEqual(at(79, 0).do, 'wait', 'then 40 min')
assert.deepStrictEqual([at(80, 0).do, s.spells.site.n], ['restart', 3])
r = at(85, 84)
assert.deepStrictEqual([r.do, r.restarts, r.minutes], ['end', 3, 65], 'data again ends the spell')
assert.strictEqual(s.spells.site, undefined)
assert.strictEqual(at(104, 84).do, 'restart', 'a new spell starts at restart 1 ...')
assert.strictEqual(s.spells.site.n, 1)

// uplink down: held, no restart, spell kept; restart on the first check after
up = 'uplink down'
r = at(124, 84)
assert.deepStrictEqual([r.do, r.first], ['hold', true])
assert.deepStrictEqual([at(130, 84).do, at(130, 84).first], ['hold', false], 'logged once')
assert.strictEqual(s.spells.site.n, 1, 'spell kept as it was')
up = null
r = at(131, 84)
assert.deepStrictEqual([r.do, r.n], ['restart', 2], 'uplink back: restart now')

// per-site threshold, and no report without a time
assert.strictEqual(new Silence({ thresholds: () => t, now: () => 700 * MIN }).check('quietsite', 0).do, null)
assert.strictEqual(new Silence({ thresholds: () => t, now: () => 720 * MIN }).check('quietsite', 0).do, 'restart')
assert.strictEqual(s.check('site', null).do, null)
assert.strictEqual(new Silence({ thresholds: () => null }).check('site', 0).do, null, 'no thresholds file: nothing done')

// uplink rule, replayed on lines from 2026-11-04 (netprobe local time)
const nd = path.join(dir, 'netprobe')
fs.mkdirSync(nd)
const icmp = ['cloudflare', 'google', 'quad9']
const knx = ['site-a', 'site-b', 'site-c', 'site-d', 'site-e']
const summary = (ts) => `${ts} SUMMARY ` + [...icmp.map((x) => `${x} 0/60 1.0/2.0`), ...knx.map((x) => `${x} 0/12 10.0/12.0`)].join(' | ') + ' | rx_dropped +0 udp_rcvbuf +0'
const lines = [summary('2026-11-04 17:28:00')]
for (let sec = 0; sec < 600; sec++) { // 17:28:30 -> 17:38:30: cloudflare+quad9 every second, sites every 5 s
    const d = new Date(2026, 10, 4, 17, 28, 30 + sec)
    const ts = `2026-11-04 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    if (d.getSeconds() === 0) lines.push(summary(ts))
    lines.push(`${ts} LOSS cloudflare quad9${sec % 5 === 0 ? ' ' + knx.join(' ') : ''}`)
}
lines.push(summary('2026-11-04 17:39:00'))
fs.writeFileSync(path.join(nd, 'netprobe-2026-11-04.log'), lines.join('\n') + '\n')
const when = (hh, mm, ss) => new Date(2026, 10, 4, hh, mm, ss).getTime()
assert.strictEqual(uplinkDown(nd, { now: when(17, 28, 20) }), null, 'before')
const down = uplinkDown(nd, { now: when(17, 33, 52) })
assert.ok(down && down.startsWith('7/8 targets down'), `during: ${down}`)
assert.strictEqual(uplinkDown(nd, { now: when(17, 39, 36) }), null, 'after')
assert.strictEqual(uplinkDown(nd, { now: when(17, 45, 0) }), null, 'netprobe silent > 2 min: no hold')
assert.strictEqual(uplinkDown(path.join(dir, 'missing'), { now: when(17, 33, 52) }), null, 'no log: no hold')

fs.rmSync(dir, { recursive: true })
console.log('silence.test.js: all checks passed')

// service.js: a worker's minute report, in report mode
{
    { const l = require('log-driver').logger; l.levels.forEach((v) => { l[v] = () => {} }) }
    for (const [m, fns] of [['db', ['writeEvents']], ['dbv2', ['writeEventsv2', 'setSurvey']]]) {
        const file = require.resolve(`../src/${m}`)
        require.cache[file] = { id: file, filename: file, loaded: true, exports: Object.fromEntries(fns.map((f) => [f, () => {}])) }
    }
    const svc = require('../src/service')._test
    const { SiteState } = require('../src/sitestate')
    const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-svc-'))
    const state = new SiteState(path.join(sdir, 'site-state.json'))
    state.set('direct', 'connected')
    let clock = Date.parse('2026-11-06T12:00:00Z')
    const sil = new Silence({ thresholds: () => t, now: () => clock })
    const out = []
    const log = console.log
    console.log = (l) => out.push(l)
    try {
        svc.setSilence(sil, { silence: 'report', locations: [{ name: 'direct', dns: 'gw.example', enabled: true }] }, state)
        const t0 = clock
        svc.alive('direct', t0)
        assert.strictEqual(state.get('direct').lastData, new Date(t0).toISOString())
        clock += 25 * MIN
        svc.alive('direct', null)            // nothing since: 25 min silent
        assert.ok(/^Silent: direct no data for 25m \(>= 20m\), restart 1: re-init \(report only\)$/.test(out.pop()), 'report line')
        assert.strictEqual(state.get('direct').silent.restarts, 1)
        assert.strictEqual(svc.lastSeen.direct, t0, 'a null report keeps the last telegram')
        clock += 1 * MIN
        svc.alive('direct', clock)           // data again
        assert.ok(/^Silent: direct data again after 1m, 1 restart\(s\) \(report only\)$/.test(out.pop()), `end line`)
        assert.strictEqual(state.get('direct').silent, undefined, 'silent cleared')
        state.set('direct', 'starting')
        assert.strictEqual(state.get('direct').lastData, new Date(clock).toISOString(), 'lastData kept across states')
        svc.setSilence(sil, { locations: [] }, state) // off: nothing logged
        clock += 60 * MIN
        svc.alive('direct', null)
        assert.strictEqual(out.length, 0, 'silence off: nothing logged')
    } finally {
        console.log = log
    }
    fs.rmSync(sdir, { recursive: true })
    console.log('silence.test.js: service checks passed')
}
