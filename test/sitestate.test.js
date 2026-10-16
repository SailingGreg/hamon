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
const { SiteState, fingerprint } = require('../src/sitestate')

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

fs.rmSync(dir, { recursive: true, force: true })
console.log(`sitestate: ${checks} checks passed`)
