#!/usr/bin/env node
/*
 * heartbeat.test.js - service.js saves tmp/site-state.json every minute even
 * with no change (its `updated` is the watchdog's hang test), and a save
 * after a signal keeps `running: false`.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { SiteState } = require('../src/sitestate')
const svc = require('../src/service')._test

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-'))
const file = path.join(dir, 'site-state.json')
let t = Date.parse('2026-11-16T10:00:00Z')
const state = new SiteState(file, { now: () => new Date(t), pid: 1234 })
state.set('a', 'connected')
svc.setSilence(null, {}, state)

assert.strictEqual(svc.HEARTBEAT, 60000)

;(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))

    // a plain save writes running: true
    svc.saveState()
    await wait(600)
    assert.strictEqual(read().running, true)
    assert.strictEqual(read().updated, '2026-11-16T10:00:00.000Z')

    // the heartbeat saves with no change: updated moves on
    const hb = svc.startHeartbeat()
    clearInterval(hb) // fire it by hand rather than wait a minute
    t += 60000
    svc.saveState()
    await wait(600)
    assert.strictEqual(read().updated, '2026-11-16T10:01:00.000Z', 'heartbeat moves updated')

    // after a signal: the signal handler saves running: false, and a site
    // changing state while it exits must not save running: true over it
    const exit = process.exit
    process.exit = () => {}
    const log = console.log
    console.log = () => {}
    process.emit('SIGTERM', 'SIGTERM')
    console.log = log
    assert.strictEqual(read().running, false, 'signal saves running: false')
    state.set('a', 'starting')
    svc.saveState()
    await wait(600)
    assert.strictEqual(read().running, false, 'a save while stopping keeps running: false')
    process.exit = exit

    fs.rmSync(dir, { recursive: true, force: true })
    console.log('heartbeat.test.js: ok')
    process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
