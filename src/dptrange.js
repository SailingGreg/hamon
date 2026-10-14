/*
 * dptrange.js - can this value be written to a GA of this DPT?
 *
 * Both KNX libraries send some out-of-range values as a different, valid-
 * looking value instead of refusing them (knx and KNXUltimate: DPT9 700000 ->
 * -9.8; KNXUltimate: 5.001 128 -> 50%, DPT7 -5 -> 0), and a plain number for a
 * composite DPT goes out as 0x00 (DPT18: recall scene 1). So mqwrite checks
 * here first, whichever decoder is in use. The ranges come from KNXUltimate's
 * DPT definitions.
 */
const DPTLib = require('knxultimate/build/dptlib')
const { dptMain, OBJECT_DPTS } = require('./dptnames')

// a pair of finite numbers, or undefined
const pair = (r) => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) ? r : undefined

// the range a plain number must be in for this DPT, or undefined if not known
function numberRange (dpt) {
    let d
    try { d = DPTLib.resolve(dpt) } catch (e) { return undefined }
    const st = d.subtype || {}
    const bt = d.basetype || {}
    const bits = bt.bitlength
    const fromBits = bt.signedness && bits > 1 && bits <= 32
        ? (bt.signedness === 'signed' ? [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1] : [0, 2 ** bits - 1])
        : undefined
    return pair(st.scalar_range) || pair(st.range) || pair(bt.range) || fromBits
}

// why the value can't be written, or undefined if it can
function writeError (dpt, value) {
    if (typeof value !== 'number') return undefined
    if (!Number.isFinite(value)) return `${value} is not a number`
    if (OBJECT_DPTS.has(dptMain(dpt))) return `${dpt} needs an object value, not ${value}`
    const range = numberRange(dpt)
    if (range && (value < range[0] || value > range[1])) return `${value} out of range [${range}] for ${dpt}`
    return undefined
}

module.exports = { writeError, numberRange }
