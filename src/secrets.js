/*
 * secrets.js - a site's KNX Secure values, read from .hamon-secrets.json
 *
 * hamon-upload keeps per-site secrets out of hamon.yml in .hamon-secrets.json
 * (mode 600, beside hamon.yml), keyed by site name. For a secure site it holds,
 * from the site's ETS project (a project with Data Secure GAs but no secure
 * gateway gives only configFile and groupKeys, used on a plain tunnel):
 *
 *   secure: { configFile, gateway, deviceAuthCode,
 *             tunnels: { '<ia>': { userId, password } },
 *             groupKeys: { '<ga>': '<base64 key>' } }
 *
 * Read-only here, and the values are never logged.
 */

const fs = require('fs')

// the site's secure entry, or undefined (no file, no entry)
function siteSecure(path, name) {
    let secrets
    try {
        secrets = JSON.parse(fs.readFileSync(path + '.hamon-secrets.json', 'utf8'))
    } catch (err) {
        if (err.code === 'ENOENT') return undefined
        throw new Error(`.hamon-secrets.json unreadable: ${err.message}`)
    }
    return secrets?.[name]?.secure
}

// the shim's secure options for a site with `secure: true`; throws with a
// message saying what to fix if the stored values don't fit the site
function secureOptions(path, location) {
    const { name, config, tunnelIA, stack } = location
    if (stack !== 'knxultimate') {
        throw new Error(`secure: true needs stack: knxultimate (site runs on ${stack || 'knx'})`)
    }
    const entry = siteSecure(path, name)
    if (!entry) {
        throw new Error('secure: true but no secure values stored - upload the site\'s ETS project in hamon-upload')
    }
    if (entry.configFile !== config) {
        throw new Error(`secure values are from ${entry.configFile}, site config is ${config} - re-upload the ETS project`)
    }
    if (!tunnelIA || !entry.tunnels?.[tunnelIA]) {
        throw new Error(`tunnelIA ${tunnelIA || '(none)'} isn't a tunnel of gateway ${entry.gateway} - set it in hamon-upload`)
    }
    if (!entry.deviceAuthCode) {
        // without it the gateway isn't authenticated (a fake one would get the password)
        throw new Error(`no device authentication code for gateway ${entry.gateway} - refusing an unauthenticated session`)
    }
    const tunnel = entry.tunnels[tunnelIA]
    return {
        tunnelIA,
        userId: tunnel.userId,
        password: tunnel.password,
        deviceAuthCode: entry.deviceAuthCode,
        groupKeys: entry.groupKeys || {},
        gateway: entry.gateway,
    }
}

// a plain-tunnel site's Data Secure group keys ({ '<ga>': base64 }), or
// undefined if none are stored: its ETS project has Data Secure GAs but the
// site doesn't use a KNX Secure tunnel (secure: true gets them with the
// tunnel, see secureOptions). Throws if they're from another GA file
function dataSecureKeys(path, location) {
    const { name, config } = location
    const entry = siteSecure(path, name)
    const keys = (entry && entry.groupKeys) || {}
    if (Object.keys(keys).length === 0) return undefined
    if (entry.configFile !== config) {
        throw new Error(`Data Secure keys are from ${entry.configFile}, site config is ${config} - re-upload the ETS project`)
    }
    return keys
}

module.exports = { siteSecure, secureOptions, dataSecureKeys }
