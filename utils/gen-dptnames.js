#!/usr/bin/env node
/*
 * gen-dptnames.js - one-off: write src/dptnames.json from knx 2.4.1's dptlib
 * (with patches/knx+2.4.1.patch applied).
 *
 * The subtype name is stored as the Influx `type` tag, so hamon keeps its own
 * frozen copy of knx's names rather than asking whichever KNX library decodes
 * the telegram. The JSON is hamon's from now on: edit it by hand for new
 * DPTs (a renamed entry starts a new series for those GAs). Re-running this
 * only makes sense while knx is still installed, to check nothing has drifted.
 *
 *   node utils/gen-dptnames.js > src/dptnames.json
 */
const DPTLib = require('knx/src/dptlib')

const out = {}
const mains = Object.keys(DPTLib)
    .filter((k) => /^DPT\d+$/.test(k) && DPTLib[k].subtypes)
    .sort((a, b) => a.slice(3) - b.slice(3))
for (const main of mains) {
    for (const sub of Object.keys(DPTLib[main].subtypes).sort()) {
        const st = DPTLib[main].subtypes[sub]
        out[`${main.slice(3)}.${sub}`] = { name: st.name || '', unit: st.unit || '' }
    }
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n')
