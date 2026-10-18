#!/usr/bin/env node
/*
 * addressrules.test.js - dptmappings' exact-address rules: parsed per
 * location, and a rule with a DPT is offered for a GA the export lacks
 * (site.js initDatapoints adds it), while a name-only rule is not.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadmapping, mapaddress, addressRules, mappingSignature } = require('../src/strtodpt')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addrrules-')) + '/'
fs.writeFileSync(dir + 'dptmappings.txt', [
    '# comment',
    '"","Temperature",DPT9.001',
    '"site-a","@1/2/3",DPT9.004,,"Outdoor brightness (not in ETS export)"',
    '"site-a","@1/2/4",DPT1.001,override,"Fixed type"',
    '"site-a","@1/2/5",,,"Name only"',
    '"site-b","@1/2/3",DPT5.001',
    '',
].join('\n'))
const log = console.log
console.log = () => {}
loadmapping(dir, 'test')
console.log = log

let checks = 0
const a = addressRules('site-a')
assert.deepStrictEqual(a.map((r) => r.ga), ['1/2/3', '1/2/4', '1/2/5'], 'site-a has its three rules')
checks++
assert.strictEqual(addressRules('site-c').length, 0, 'no rules for another site')
checks++
assert.deepStrictEqual(mapaddress('site-a', '1/2/3'),
    { loc: 'site-a', ga: '1/2/3', dpt: 'DPT9.004', override: false, name: 'Outdoor brightness (not in ETS export)' })
checks++

// what initDatapoints adds to a site's GA table from its rules
const exportGas = { '1/2/4': { name: 'In export', dpt: 'DPT5.001' } }
const added = a.filter((r) => r.dpt !== undefined && !exportGas.hasOwnProperty(r.ga)).map((r) => r.ga)
assert.deepStrictEqual(added, ['1/2/3'], 'adds the missing GA with a DPT, not the name-only rule or one already exported')
checks++

// service.js restarts a running site when the lines it uses change
const before = { a: mappingSignature(dir, 'site-a'), b: mappingSignature(dir, 'site-b'), c: mappingSignature(dir, 'site-c') }
fs.appendFileSync(dir + 'dptmappings.txt', '"site-a","@1/2/6",DPT9.001\n# a comment\n')
assert.notStrictEqual(mappingSignature(dir, 'site-a'), before.a, "site-a's own new rule changes its signature")
assert.strictEqual(mappingSignature(dir, 'site-b'), before.b, "site-b is unaffected by site-a's rule or a comment")
checks += 2
fs.appendFileSync(dir + 'dptmappings.txt', '"","Humidity",DPT9.007\n')
assert.notStrictEqual(mappingSignature(dir, 'site-c'), before.c, 'a shared rule changes every site')
assert.notStrictEqual(mappingSignature(dir, 'site-b'), before.b, 'a shared rule changes every site')
checks += 2
assert.strictEqual(mappingSignature(dir + 'missing/', 'site-a'), '', 'no file')
checks++

fs.rmSync(dir, { recursive: true })
console.log(`addressrules: ${checks} checks passed`)
