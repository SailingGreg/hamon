#!/usr/bin/env node
/*
 * backoffdns.test.js - while a site waits out its back-off, its DNS name is
 * looked up again (service.js watchDns): a new address restarts it at once,
 * the same address or a failed lookup doesn't.
 */
const assert = require('assert')
{ const l = require('log-driver').logger; l.levels.forEach((v) => { l[v] = () => {} }) }
for (const [m, fns] of [['db', ['writeEvents']], ['dbv2', ['writeEventsv2', 'setSurvey']]]) {
    const file = require.resolve(`../src/${m}`)
    require.cache[file] = { id: file, filename: file, loaded: true, exports: Object.fromEntries(fns.map((f) => [f, () => {}])) }
}
const { watchDns } = require('../src/service')._test

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
// a lookup that answers from a list, one entry per call (null = fails)
const answers = (list) => {
    let i = 0
    return () => {
        const a = list[Math.min(i++, list.length - 1)]
        return a == null ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve({ address: a })
    }
}

let checks = 0
async function run(list, ms) {
    const seen = []
    const stop = watchDns('site.example', 10, (was, now) => seen.push([was, now]), answers(list))
    await wait(ms)
    stop()
    return seen
}

(async () => {
    assert.deepStrictEqual(await run(['1.2.3.4'], 60), [], 'same address: no restart'); checks++
    assert.deepStrictEqual(await run(['1.2.3.4', '1.2.3.4', null, '5.6.7.8', '9.9.9.9'], 80),
                           [['1.2.3.4', '5.6.7.8']], 'new address after a failed lookup: one restart'); checks++
    assert.deepStrictEqual(await run([null, null, '5.6.7.8'], 60), [[null, '5.6.7.8']],
                           'a name that starts resolving: restart'); checks++
    // stopped before the change: nothing
    const seen = []
    const stop = watchDns('site.example', 10, (was, now) => seen.push([was, now]), answers(['1.2.3.4', '5.6.7.8']))
    stop()
    await wait(40)
    assert.deepStrictEqual(seen, [], 'stopped watch: no restart'); checks++
    console.log(`backoffdns: ${checks} checks passed`)
    process.exit(0)
})()
