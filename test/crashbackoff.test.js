#!/usr/bin/env node
/*
 * crashbackoff.test.js - a GA with a DPT the decoder doesn't know no longer
 * ends its site (site.js buildEndpoint), and a site whose worker keeps
 * erroring right after it connects still backs off (service.js noteCrash):
 * the connect resets the restart count, the worker errors don't.
 */
const assert = require('assert')
{ const l = require('log-driver').logger; l.levels.forEach((v) => { l[v] = () => {} }) }
for (const [m, fns] of [['db', ['writeEvents']], ['dbv2', ['writeEventsv2', 'setSurvey']]]) {
    const file = require.resolve(`../src/${m}`)
    require.cache[file] = { id: file, filename: file, loaded: true, exports: Object.fromEntries(fns.map((f) => [f, () => {}])) }
}
const knx = require('knx')
const { buildEndpoint } = require('../src/site')
const { Datapoint: UltimateDatapoint } = require('../src/datapoint')
const { noteCrash, backoffDelay, failures } = require('../src/service')._test

let checks = 0
const conn = { on: () => {} }

// knx has no DPT27: it throws, so the GA gets a datapoint without a DPT
assert.throws(() => new knx.Datapoint({ ga: '15/0/14', dpt: 'DPT27.001' }, conn))
let b = buildEndpoint(knx.Datapoint, '15/0/14', 'DPT27.001', conn)
assert.strictEqual(b.unsupported, true, 'knx 27.001: unsupported')
assert.ok(b.endpoint, 'knx 27.001: still has an endpoint')
b = buildEndpoint(knx.Datapoint, '0/0/1', 'DPT1.001', conn)
assert.strictEqual(b.unsupported, false, 'knx 1.001: supported')
b = buildEndpoint(UltimateDatapoint, '15/0/14', 'DPT27.001', conn)
assert.strictEqual(b.unsupported, false, 'knxultimate 27.001: supported')
checks += 4

// the worker errors right after each connect: connect sets failures to 0
// (as service.js does), then the error. Immediate restarts while the count is
// within RESTART_FREE, then the back-off
const t0 = Date.now()
const delays = []
for (let i = 0; i < 6; i++) {
    failures['site-a'] = 0                          // connected
    noteCrash('site-a', t0 + i * 1000)              // worker error
    failures['site-a']++                            // requestRestart's own count
    delays.push(backoffDelay(failures['site-a']) / 60000)
}
assert.deepStrictEqual(delays, [0, 0, 0, 15, 30, 60], 'errors after each connect back off')
checks++

// an error after CRASH_QUIET with no other starts the count again
failures['site-a'] = 0
noteCrash('site-a', t0 + 5000 + 11 * 60 * 1000)
failures['site-a']++
assert.strictEqual(backoffDelay(failures['site-a']), 0, 'a lone error 10min+ later restarts at once')
checks++

console.log(`crashbackoff: ${checks} checks passed`)
process.exit(0)
