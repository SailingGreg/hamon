#!/usr/bin/env node
/*
 * knxstack.test.js - the stack a location runs on (knxstack.effective):
 * its own `stack:`, else the top-level `stack:` in hamon.yml, else knx.
 */
const assert = require('assert')
const effective = require('../src/knxstack').effective

const cases = [
    // [site stack, top-level stack, expected]
    [undefined, undefined, 'knx'],
    ['', null, 'knx'],
    [undefined, 'knxultimate', 'knxultimate'],
    ['', 'knxultimate', 'knxultimate'],
    ['knx', 'knxultimate', 'knx'],          // a site held back on knx
    ['knxultimate', undefined, 'knxultimate'],
    ['knxultimate', 'knx', 'knxultimate'],
]
for (const [site, top, want] of cases) {
    assert.strictEqual(effective(site, top), want, `site ${site}, top-level ${top}`)
}

// service.js restarts a site only when this changes: moving the top-level
// default to knxultimate leaves sites already on knxultimate alone
assert.strictEqual(effective('knxultimate', undefined), effective('knxultimate', 'knxultimate'))
assert.notStrictEqual(effective(undefined, undefined), effective(undefined, 'knxultimate'))

console.log(`knxstack: ${cases.length} stack choices as expected`)
