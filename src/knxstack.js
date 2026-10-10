/*
 * knxstack.js - pick the KNX stack for a location (hamon.yml `stack:`)
 *
 *   knx          (default) the knx 2.4.1 package, as before
 *   knxultimate  KNXUltimate for the transport (UDP now; TCP / KNX Secure later),
 *                presented through the same Connection API by ultimate-shim.js
 *
 * Either way the caller gets { Connection, Datapoint } and Datapoint is always
 * knx's own, so values are decoded by the same dptlib and the Influx data
 * (value, type, unit) is identical whichever stack a site uses.
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
