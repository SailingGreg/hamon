/*
 * dptnames.js - the type name (Influx `type` tag) and unit for a GA's DPT
 *
 * From hamon's own frozen table (dptnames.json, generated once from knx 2.4.1
 * by utils/gen-dptnames.js), so the stored series don't depend on which KNX
 * library decodes the telegram.
 *
 * The lookup follows knx's dptlib.resolve(): a DPT given as the main type only
 * ('DPT9') or with an unknown subtype has no name - and dbv2 doesn't store a
 * GA without one - exactly as before.
 */
const NAMES = require('./dptnames.json')

// DPTs come in as 9 / '9' / '9.001' / 'DPT9.001' (as knx accepts them)
const DPT_ID = /^(?:DPT)?(\d+)(?:\.(\d+))?$/

// { name, unit } for a DPT id, or undefined if it has no subtype name
function dptInfo (dpt) {
    if (dpt === undefined || dpt === null) return undefined
    const m = String(dpt).toUpperCase().match(DPT_ID)
    if (m === null || m[2] === undefined) return undefined
    return NAMES[`${m[1]}.${m[2]}`]
}

module.exports = { dptInfo }
