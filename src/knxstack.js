/*
 * knxstack.js - pick the KNX stack for a location (hamon.yml `stack:`; the
 * top-level `stack:` is the default for every location, see effective())
 *
 *   knx          (default) the knx 2.4.1 package, as before
 *   knxultimate  KNXUltimate for the transport (UDP now; TCP / KNX Secure later),
 *                presented through the same Connection API by ultimate-shim.js
 *
 * Either way the caller gets { Connection, Datapoint } with knx's Datapoint;
 * connection.js swaps in datapoint.js (KNXUltimate's dptlib) for knxultimate
 * sites, so the stack picks the decoder too. Type names and units come from
 * dptnames.json, so the Influx data is the same either way.
 */

module.exports = function (stack) {
    const knx = require('knx')
    if (stack == null || stack === '' || stack === 'knx') {
        return knx
    }
    if (stack === 'knxultimate') {
        // required here, not at the top: sites on the default stack don't need
        // knxultimate installed. It's an optionalDependency because it needs
        // Node >= 18, so an install on an older Node skips it rather than failing
        try {
            require.resolve('knxultimate')
        } catch (e) {
            throw new Error(`stack knxultimate: package not installed (needs Node >= 18, this is ${process.version})`)
        }
        const { Connection } = require('./ultimate-shim')
        return { Connection, Datapoint: knx.Datapoint }
    }
    throw new Error(`unknown knx stack '${stack}' (use knx or knxultimate)`)
}

// the stack a location runs on: its own `stack:`, else the top-level `stack:`
// in hamon.yml, else knx
module.exports.effective = function (siteStack, defaultStack) {
    for (const s of [siteStack, defaultStack]) {
        if (s != null && s !== '') return s
    }
    return 'knx'
}
