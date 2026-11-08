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
assert.deepStrictEqual(t, { default: 20, cooldown: 20, cooldownMax: 240, grace: 1440, maxRestarts: 6, sites: { quietsite: 720 } })
fs.writeFileSync(path.join(dir, 'max'), 'default 20\ncooldown 20\ncooldown_max 240\nmax_restarts 3\n')
assert.deepStrictEqual([loadThresholds(path.join(dir, 'max')).maxRestarts, loadThresholds(path.join(dir, 'max')).sites], [3, {}], 'max_restarts is not a site')
fs.writeFileSync(path.join(dir, 'nograce'), 'default 20\ncooldown 20\ncooldown_max 240\n')
assert.strictEqual(loadThresholds(path.join(dir, 'nograce')).grace, 1440, 'grace defaults to 24 h')
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

// new-site grace: first connected less than `grace` ago - not restarted, logged once
{
    let gnow = 0
    const g = new Silence({ thresholds: () => t, now: () => gnow })
    const chk = (m, first) => { gnow = m * MIN; return g.check('new', 0, first == null ? null : first * MIN) }
    let r = chk(30, 0)
    assert.deepStrictEqual([r.do, r.first, r.until, r.since], ['grace', true, 1440 * MIN, 30 * MIN], 'in grace')
    r = chk(60, 0)
    assert.deepStrictEqual([r.do, r.first, r.since], ['grace', false, 30 * MIN], 'logged once, since kept')
    assert.strictEqual(g.spells.new, undefined, 'no spell in grace')
    assert.strictEqual(chk(1440, 0).do, 'restart', 'grace over: restart')
    assert.strictEqual(new Silence({ thresholds: () => t, now: () => 30 * MIN }).check('old', 0, null).do, 'restart', 'no firstConnected on record: an established site')
}

// max_restarts: after the last restart's cooldown, stop until data (logged once)
{
    let mnow = 0
    const t3 = { ...t, maxRestarts: 3 }
    const m = new Silence({ thresholds: () => t3, now: () => mnow })
    const chk = (min, last = 0) => { mnow = min * MIN; return m.check('dead', last * MIN) }
    assert.deepStrictEqual([chk(20).n, chk(40).n, chk(80).n], [1, 2, 3], 'three restarts')
    assert.strictEqual(chk(159).do, 'wait', 'the third restart gets its cooldown')
    let r = chk(160)
    assert.deepStrictEqual([r.do, r.n], ['stop', 3], 'then stop')
    assert.strictEqual(chk(400).do, 'stopped', 'logged once, no more restarts')
    assert.strictEqual(chk(2000).do, 'stopped', 'even past cooldown_max')
    r = chk(2001, 2000)
    assert.deepStrictEqual([r.do, r.restarts], ['end', 3], 'data again ends it')
    assert.deepStrictEqual([chk(2020, 2000).do, m.spells.dead.n], ['restart', 1], 'next spell starts over')
    const u = new Silence({ thresholds: () => ({ ...t, maxRestarts: 0 }), now: () => 100000 * MIN })
    u.spells.x = { n: 50, t: 0, since: 0 }
    assert.strictEqual(u.check('x', 0).do, 'restart', '0 never stops')
}

// restore: a spell carried over an ha-mon restart, downtime not counted
{
    let rnow = 1000 * MIN
    const g = new Silence({ thresholds: () => t, now: () => rnow })
    g.restore('site', { since: new Date(500 * MIN).toISOString(), restarts: 2, next: new Date(1030 * MIN).toISOString() }, 5 * MIN)
    assert.deepStrictEqual(g.spells.site, { n: 2, t: 995 * MIN, since: 505 * MIN, stopped: false }, 'last restart = next - cooldown, shifted by downtime')
    g.restore('site', { since: new Date(0).toISOString(), restarts: 9 })
    assert.strictEqual(g.spells.site.n, 2, 'an existing spell is kept')
    g.restore('held', { since: new Date(0).toISOString(), restarts: 0, held: 'uplink' })
    assert.strictEqual(g.spells.held, undefined, 'no restarts yet: nothing to carry')
    g.restore('stopped', { since: new Date(0).toISOString(), restarts: 6, stopped: true })
    assert.strictEqual(g.check('stopped', 0).do, 'stopped', 'stopped stays stopped')
    rnow = 1035 * MIN
    assert.deepStrictEqual([g.check('site', 0).do, g.spells.site.n], ['restart', 3], 'carried spell goes on to restart 3')
}

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
    delete state.sites.direct.firstConnected // an established site, not a new one
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
        // a brand-new site: firstConnected on its first connection, then grace
        const st2 = new SiteState(path.join(sdir, 's2.json'), { now: () => new Date(clock) })
        st2.set('fresh', 'connected')
        assert.strictEqual(st2.get('fresh').firstConnected, new Date(clock).toISOString(), 'firstConnected set')
        st2.set('fresh', 'down'); clock += MIN; st2.set('fresh', 'connected')
        assert.strictEqual(st2.get('fresh').firstConnected, new Date(clock - MIN).toISOString(), 'kept on a reconnect')
        st2.set('old', 'connected'); st2.sites.old.lastConnected = new Date(clock - 31 * 1440 * MIN).toISOString()
        delete st2.sites.old.firstConnected; st2.set('old', 'connected')
        assert.strictEqual(st2.get('old').firstConnected, new Date(clock).toISOString(), 'back after 30 days: new again')
        const st3 = new SiteState(path.join(sdir, 's3.json'), { now: () => new Date(clock) })
        st3.sites.known = { state: 'starting', lastConnected: new Date(clock - 3600000).toISOString() }
        st3.set('known', 'connected')
        assert.strictEqual(st3.get('known').firstConnected, undefined, 'an existing site is not new')
        svc.setSilence(sil, { silence: 'report', locations: [{ name: 'fresh', dns: 'gw.example', enabled: true }] }, st2)
        svc.alive('fresh', clock)
        clock += 25 * MIN
        svc.alive('fresh', null)
        assert.ok(/^Silent: fresh no data for 25m \(>= 20m\), new site - not restarted until \S+ \(report only\)$/.test(out.pop()), 'grace line')
        assert.ok(st2.get('fresh').silent.grace, 'grace in the state')
        // an ha-mon restart: the silence clock and spell carry over, minus the downtime
        const sf = path.join(sdir, 'carry.json')
        const prev = new SiteState(sf, { now: () => new Date(clock) })
        prev.set('carried', 'connected'); delete prev.sites.carried.firstConnected
        prev.note('carried', { lastData: new Date(clock - 30 * MIN).toISOString(),
                               silent: { since: new Date(clock - 10 * MIN).toISOString(), restarts: 1, next: new Date(clock + 10 * MIN).toISOString() } })
        prev.set('nodata', 'connected'); delete prev.sites.nodata.firstConnected
        prev.note('nodata', { silent: { since: new Date(clock - 600 * MIN).toISOString(), restarts: 4, next: new Date(clock + 100 * MIN).toISOString() } })
        prev.save(false)
        clock += 2 * MIN // stopped for 2 min
        const next = new SiteState(sf, { now: () => new Date(clock) })
        next.load()
        assert.strictEqual(next.downtime, 2 * MIN, 'downtime from the file')
        const sil2 = new Silence({ thresholds: () => t, now: () => clock })
        svc.setSilence(sil2, { silence: 'report', locations: [{ name: 'carried', dns: 'gw.example', enabled: true }, { name: 'nodata', dns: 'gw.example', enabled: true }] }, next)
        clock += MIN
        svc.alive('carried', null)
        assert.strictEqual(svc.lastSeen.carried, clock - 3 * MIN - 30 * MIN + 2 * MIN, 'clock from lastData, downtime left out')
        assert.strictEqual(sil2.spells.carried.n, 1, 'spell carried')
        assert.strictEqual(out.length, 0, 'still in its cooldown: nothing logged')
        svc.alive('nodata', null)
        assert.strictEqual(svc.lastSeen.nodata, clock - 3 * MIN - 600 * MIN - 20 * MIN + 2 * MIN, 'no lastData: spell start less the threshold')
        assert.strictEqual(sil2.spells.nodata.n, 4)
        clock += 100 * MIN
        svc.alive('nodata', null)
        assert.ok(/^Silent: nodata no data for \d+m \(>= 20m\), restart 5: re-init \(report only\)$/.test(out.pop()), 'restart 5, not 1')
        clock += 240 * MIN
        svc.alive('nodata', null)
        assert.ok(/^Silent: nodata no data for \d+m \(>= 20m\), restart 6: re-init/.test(out.pop()), 'restart 6')
        clock += 240 * MIN
        svc.alive('nodata', null)
        assert.ok(/^Silent: nodata no data for \d+m \(>= 20m\), 6 restarts haven't helped - no more until data/.test(out.pop()), `stop line`)
        assert.deepStrictEqual(next.get('nodata').silent.stopped, true, 'stopped in the state')
        clock += 240 * MIN
        svc.alive('nodata', null)
        assert.strictEqual(out.length, 0, 'stopped: logged once')
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
