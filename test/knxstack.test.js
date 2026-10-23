#!/usr/bin/env node
/*
 * knxstack.test.js - the stack a location runs on (knxstack.effective):
 * the top-level `stack:` in hamon.yml, else its own `stack:`, else knx.
 */
const assert = require('assert')
const effective = require('../src/knxstack').effective

const cases = [
    // [site stack, top-level stack, expected]
    [undefined, undefined, 'knx'],
    ['', null, 'knx'],
    [undefined, 'knxultimate', 'knxultimate'],
    ['', 'knxultimate', 'knxultimate'],
    ['knx', 'knxultimate', 'knxultimate'],  // a top-level stack is every site's
    ['knxultimate', undefined, 'knxultimate'],
    ['knxultimate', 'knx', 'knx'],
    ['knx', undefined, 'knx'],              // no top-level: a site's own applies
]
for (const [site, top, want] of cases) {
    assert.strictEqual(effective(site, top), want, `site ${site}, top-level ${top}`)
}

// service.js restarts a site only when this changes: moving the top-level
// default to knxultimate leaves sites already on knxultimate alone
assert.strictEqual(effective('knxultimate', undefined), effective('knxultimate', 'knxultimate'))
assert.notStrictEqual(effective(undefined, undefined), effective(undefined, 'knxultimate'))

console.log(`knxstack: ${cases.length} stack choices as expected`)
