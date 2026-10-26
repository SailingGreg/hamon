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

// a knxultimate site doesn't load the knx package (knx stays only for sites
// on the knx stack); a fresh process, as this one may have loaded it already
const { execFileSync } = require('child_process')
const loaded = (stack) => JSON.parse(execFileSync(process.execPath, ['-e', `
    // stub the InfluxDB writers (they need src/.env), as misconfig.test.js does
    for (const m of ['db', 'dbv2']) {
        const file = require.resolve('./src/' + m)
        require.cache[file] = { id: file, filename: file, loaded: true, exports: {} }
    }
    require('./src/site'); require('./src/datasecure')
    const s = require('./src/knxstack')(${JSON.stringify(stack)})
    if (stack === 'knxultimate') require('./src/ultimate-shim')
    console.log(JSON.stringify(Object.keys(require.cache).some((f) => /[\\/]node_modules[\\/]knx[\\/]/.test(f))))
`.replace('stack ===', `${JSON.stringify(stack)} ===`)], { cwd: require('path').join(__dirname, '..') }).toString().trim().split('\n').pop())
assert.strictEqual(loaded('knxultimate'), false, 'knxultimate stack loads the knx package')
assert.strictEqual(loaded('knx'), true, 'knx stack should load the knx package')

console.log(`knxstack: ${cases.length} stack choices as expected; knxultimate sites don't load knx`)
