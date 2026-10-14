/*
 * coerce.js - turn an MQTT payload (a string) into the value a group address's
 * DPT expects, for mqwrite.js. Kept apart from mqwrite so it can be tested
 * without the MQTT and InfluxDB modules.
 */
const { dptMain, OBJECT_DPTS } = require('./dptnames')

// Convert the raw MQTT string payload into the JS type the group address's DPT
// expects, so the Datapoint's write() encodes it correctly. Replaces the old
// unconditional parseInt(), which turned floats (21.5 -> 21), strings and
// booleans (e.g. "On" -> NaN) into bad values and broke the write.
// NaN means "don't send": mqwrite refuses it.
function coerceForDpt (dpt, raw) {
  const s = String(raw).trim()
  const main = dptMain(dpt)
  // a GA with no DPT would be written as DPT1, and knx inverts numeric 1/0
  if (main === undefined) return NaN
  // composite DPTs take an object (Node-RED sends JSON), e.g. DPT18
  // {"save_recall":0,"scenenumber":5}, DPT3 {"decr_incr":1,"data":3}; a bare
  // number would be encoded as 0x00 (for DPT18: recall scene 1)
  if (OBJECT_DPTS.has(main)) return compositeValue(main, s)
  if (s.length === 0) return 0
  switch (main) {
    case 1:                 // boolean: switch / bool / enable ...
      return /^(1|on|true|yes|enable)$/i.test(s)
    case 9:                 // 2-byte float (temperature, humidity, ...)
    case 14:                // 4-byte float
      return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? parseFloat(s) : NaN
    case 16:                // character string
      return s
    default:                // integer DPTs: DPT5/6/7/8/12/13/17/20 (scaling, counts, ...)
      return /^[-+]?\d+(\.\d+)?$/.test(s) ? Math.round(Number(s)) : NaN
  }
}

function compositeValue (main, s) {
  if (s.startsWith('{')) {
    try {
      const v = JSON.parse(s)
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v
    } catch (e) { /* not JSON - refused below */ }
    return NaN
  }
  // DPT18: a bare scene number (1-64, as ETS shows it) recalls that scene
  if (main === 18 && /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 64) {
    return { save_recall: 0, scenenumber: Number(s) }
  }
  // time / date / date-time: anything Date can parse
  if ((main === 10 || main === 11 || main === 19) && s.length > 0 && Number.isFinite(Date.parse(s))) {
    return new Date(s)
  }
  return NaN
}

module.exports = { coerceForDpt }
