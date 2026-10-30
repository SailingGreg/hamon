#!/usr/bin/env node
/*
 * sitestate.test.js - the per-site state service.js keeps in
 * tmp/site-state.json: state changes, blocks tied to the site's config, and
 * the file surviving a restart (or being missing or damaged).
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { SiteState, fingerprint, needsPrecheck } = require('../src/sitestate')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitestate-'))
const file = path.join(dir, 'site-state.json')
let t = Date.parse('2026-10-16T10:00:00Z')
const clock = () => new Date(t)
let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++ }

// a missing file starts empty
let st = new SiteState(file, { now: clock, pid: 1234 })
ok(!st.load(), 'missing file: load() is false')
eq(st.sites, {}, 'missing file: no sites')

// starting -> connected: lastConnected set, failures reset
st.set('a', 'starting', { failures: 2 })
eq(st.get('a').failures, 2, 'starting keeps the count')
t += 60000
st.set('a', 'connected')
eq(st.get('a').failures, 0, 'connected resets the count')
eq(st.get('a').lastConnected, '2026-10-16T10:01:00.000Z', 'connected sets lastConnected')
eq(st.get('a').since, '2026-10-16T10:01:00.000Z', 'since moves on a state change')

// connected again (a reconnect): lastConnected moves, since stays
t += 60000
st.set('a', 'connected')
eq(st.get('a').lastConnected, '2026-10-16T10:02:00.000Z', 'reconnect moves lastConnected')
eq(st.get('a').since, '2026-10-16T10:01:00.000Z', 'since stays while the state is unchanged')

// down carries nextRetry; it goes when the state changes
st.set('b', 'down', { failures: 5, nextRetry: '2026-10-16T12:00:00.000Z' })
eq(st.get('b').nextRetry, '2026-10-16T12:00:00.000Z', 'down has nextRetry')
st.set('b', 'starting', { failures: 5 })
ok(!('nextRetry' in st.get('b')), 'nextRetry dropped once starting')

// blocked is tied to the config it was blocked with
const loc = { name: 'c', enabled: true, dns: 'gw.invalid', port: 3671, config: 'c.xml', phyAddr: '1.1.250' }
const fp = fingerprint(loc, 'knxultimate', 1700000000000)
st.set('c', 'blocked', { reason: 'dns', detail: 'DNS lookup failed for gw.invalid', fingerprint: fp })
ok(st.stillBlocked('c', fp), 'blocked with the same config')
ok(!st.stillBlocked('c', fingerprint({ ...loc, dns: 'gw2.invalid' }, 'knxultimate', 1700000000000)), 'dns changed')
ok(!st.stillBlocked('c', fingerprint({ ...loc, port: 3672 }, 'knxultimate', 1700000000000)), 'port changed')
ok(!st.stillBlocked('c', fingerprint(loc, 'knx', 1700000000000)), 'stack changed')
ok(!st.stillBlocked('c', fingerprint(loc, 'knxultimate', 1700000000001)), 'GA file changed')
ok(st.stillBlocked('c', fingerprint({ ...loc, port: '3671' }, 'knxultimate', 1700000000000)), 'port 3671 == "3671"')
ok(!st.stillBlocked('c', fingerprint({ ...loc, transport: 'tcp' }, 'knxultimate', 1700000000000)), 'transport set')
// a block stored before `transport` existed still matches a site without it
ok(fp === '{"enabled":"true","dns":"gw.invalid","port":"3671","device":null,"logging":null,"phyAddr":"1.1.250","config":"c.xml","secure":null,"tunnelIA":null,"stack":"knxultimate","mtime":1700000000000}',
    'fingerprint without transport unchanged')
ok(!st.stillBlocked('a', fp), 'a connected site is not blocked')
ok(!st.stillBlocked('nobody', fp), 'an unknown site is not blocked')

// leaving blocked drops reason/detail/fingerprint
st.set('c', 'starting')
ok(!('reason' in st.get('c')) && !('fingerprint' in st.get('c')), 'unblocked: reason and fingerprint gone')
st.set('c', 'blocked', { reason: 'dns', detail: 'x', fingerprint: fp })

// save + load: what the next start sees
st.set('d', 'disabled')
eq(st.save(), null, 'save() succeeds')
ok(!fs.existsSync(file + '.tmp'), 'no .tmp left behind')
const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
eq(doc.pid, 1234, 'file has the pid')
eq(doc.running, true, 'file says running')
st.save(false)
eq(JSON.parse(fs.readFileSync(file, 'utf8')).running, false, 'stopped ha-mon says running: false')

const st2 = new SiteState(file, { now: clock })
ok(st2.load(), 'reload')
eq(st2.sites, st.sites, 'every site carried over')
ok(st2.stillBlocked('c', fp), 'block carried over')

// sites gone from hamon.yml drop out
st2.retain(['a', 'c'])
eq(Object.keys(st2.sites).sort(), ['a', 'c'], 'retain() drops removed sites')

// a damaged file starts empty, as before the file existed
fs.writeFileSync(file, '{"sites": {"a": ')
const st3 = new SiteState(file)
ok(!st3.load(), 'damaged file: load() is false')
eq(st3.sites, {}, 'damaged file: no sites')

// an unwritable location: save() returns the error, nothing throws
const st4 = new SiteState(path.join(dir, 'no-such-dir', 'site-state.json'))
ok(st4.save() instanceof Error, 'save() to a missing dir returns the error')

// the gateway check before the tunnel: only for a site with no connection
// in the last 7 days, so a live site that's briefly down is never blocked
const at = new Date('2026-10-16T12:00:00Z')
ok(needsPrecheck(undefined, at), 'a new site is checked')
ok(needsPrecheck({ state: 'down', lastConnected: null }, at), 'never connected: checked')
ok(!needsPrecheck({ state: 'down', lastConnected: '2026-10-16T09:00:00Z' }, at), 'connected today: not checked')
ok(!needsPrecheck({ state: 'down', lastConnected: '2026-10-09T12:00:01Z' }, at), 'just under 7 days: not checked')
ok(needsPrecheck({ state: 'down', lastConnected: '2026-10-09T11:59:59Z' }, at), 'over 7 days: checked')
ok(needsPrecheck({ state: 'down', lastConnected: 'garbage' }, at), 'unreadable time: checked')

// misconfigured is held like blocked: tied to the config, kept across a
// restart, and its reason dropped when it leaves the state
const st5 = new SiteState(path.join(dir, 'm.json'), { now: clock })
const mloc = { ...loc, name: 'm', secure: true }
const mfp = fingerprint(mloc, 'knxultimate', 1700000000000)
st5.set('m', 'misconfigured', { reason: 'config', detail: 'no device authentication code', fingerprint: mfp })
eq(st5.get('m').detail, 'no device authentication code', 'misconfigured keeps its detail')
ok(st5.stillBlocked('m', mfp), 'misconfigured with the same config is held')
ok(!st5.stillBlocked('m', fingerprint(mloc, 'knxultimate', 1700000000001)), 'a new GA file releases it')
ok(!st5.stillBlocked('m', fingerprint({ ...mloc, tunnelIA: '1.1.9' }, 'knxultimate', 1700000000000)), 'a hamon.yml change releases it')
ok(!st5.stillBlocked('m', fingerprint(mloc, 'knxultimate', null)), 'a GA file that has gone (no mtime) releases it')
st5.save()
const st6 = new SiteState(path.join(dir, 'm.json'))
ok(st6.load() && st6.stillBlocked('m', mfp), 'misconfigured survives a save and reload')
st5.set('m', 'starting')
ok(!('reason' in st5.get('m')) && !('detail' in st5.get('m')), 'restarted: reason and detail gone')

fs.rmSync(dir, { recursive: true, force: true })
console.log(`sitestate: ${checks} checks passed`)
