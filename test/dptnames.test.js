#!/usr/bin/env node
/*
 * dptnames.test.js - check src/dptnames.json gives every GA the same type name
 * and unit that knx 2.4.1's dptlib gave (needs knx installed).
 *
 *   node test/dptnames.test.js [<config dir> [dptmappings.txt]]
 *
 * Always compares the whole table with knx. With a config dir, also checks the
 * DPT of every GA in every ETS export (.xml) there, after the default subtype
 * connection.js adds, plus every DPT a dptmappings.txt rule can assign.
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
{ const l = require('log-driver').logger; l.levels.forEach((v) => { l[v] = () => {} }) }
const DPTLib = require('knx/src/dptlib')
const { dptInfo } = require('../src/dptnames')
const NAMES = require('../src/dptnames.json')

// as connection.js
const DEFAULT_SUBTYPE = { DPT1: '.001', DPT3: '.007', DPT5: '.001', DPT7: '.001', DPT8: '.001', DPT9: '.001', DPT18: '.001' }

// what connection.js stored before: knx.Datapoint's dpt.subtype name/unit
function knxInfo (dpt) {
    let d
    try { d = DPTLib.resolve(dpt === undefined ? 'DPT1' : dpt) } catch (e) { return undefined }
    return d.subtype === undefined ? undefined : { name: d.subtype.name || '', unit: d.subtype.unit || '' }
}
const same = (dpt) => {
    const a = dptInfo(dpt), b = knxInfo(dpt)
    assert.deepStrictEqual(a === undefined ? '' : a, b === undefined ? '' : b, `DPT ${dpt}: table ${JSON.stringify(a)} knx ${JSON.stringify(b)}`)
}

// 1. the table against knx, both ways
let n = 0
for (const main of Object.keys(DPTLib).filter((k) => /^DPT\d+$/.test(k) && DPTLib[k].subtypes)) {
    for (const sub of Object.keys(DPTLib[main].subtypes)) { same(`${main}.${sub}`); n++ }
}
assert.strictEqual(Object.keys(NAMES).length, n, 'table and knx have a different number of subtypes')
for (const id of ['DPT9', '9', 'dpt9.001', '9.001', 'DPT9.1', 'DPT999.001', 'nonsense', undefined]) same(id)
console.log(`table: ${n} subtypes match knx`)

// 2. every GA in the given ETS exports, and every dptmappings rule DPT
const dir = process.argv[2]
if (dir) {
    const ets = require('../parsexml')
    const log = console.log; console.log = () => {}   // parsexml is chatty
    let gas = 0, files = 0
    const seen = new Set()
    try {
        for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.xml'))) {
            const ga = ets.parsexml(path.join(dir, f)) || {}
            files++
            for (const key of Object.keys(ga)) {
                let dpt = ga[key].dpt
                if (DEFAULT_SUBTYPE[dpt] !== undefined) dpt += DEFAULT_SUBTYPE[dpt]
                seen.add(String(dpt)); gas++
                same(dpt)
            }
        }
    } finally { console.log = log }
    const maps = process.argv[3]
    let rules = 0
    if (maps) {
        for (const m of fs.readFileSync(maps, 'utf8').matchAll(/\b(?:DPT)?\d+\.\d{3}\b/gi)) { same(m[0]); rules++ }
    }
    console.log(`configs: ${files} files, ${gas} GAs (${seen.size} distinct DPTs) match knx; ${rules} dptmappings DPTs match`)
}
