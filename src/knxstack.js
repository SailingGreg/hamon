/*
 * knxstack.js - pick the KNX stack for a location (hamon.yml `stack:`; a
 * top-level `stack:` applies to every location, see effective())
 *
 *   knx          (default) the knx 2.4.1 package, as before
 *   knxultimate  KNXUltimate for the transport (UDP now; TCP / KNX Secure later),
 *                presented through the same Connection API by ultimate-shim.js
 *
 * Either way the caller gets { Connection, Datapoint }: knx's own, or the shim
 * and datapoint.js (KNXUltimate's dptlib), so the stack picks the decoder too
 * and a knxultimate site never loads the knx package. Type names and units come
 * from dptnames.json, so the Influx data is the same either way.
 */

module.exports = function (stack) {
    if (stack == null || stack === '' || stack === 'knx') {
        return require('knx')
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
        return { Connection, Datapoint: require('./datapoint').Datapoint }
    }
    throw new Error(`unknown knx stack '${stack}' (use knx or knxultimate)`)
}

// the stack a location runs on: the top-level `stack:` in hamon.yml, else its
// own `stack:`, else knx. A top-level stack is every site's - a site's own
// can't put it back on knx (hamon-upload drops the line, its checker flags it)
module.exports.effective = function (siteStack, defaultStack) {
    for (const s of [defaultStack, siteStack]) {
        if (s != null && s !== '') return s
    }
    return 'knx'
}
