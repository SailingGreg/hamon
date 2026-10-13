/*
 * secrets.js - a site's KNX Secure values, read from .hamon-secrets.json
 *
 * hamon-upload keeps per-site secrets out of hamon.yml in .hamon-secrets.json
 * (mode 600, beside hamon.yml), keyed by site name. For a secure site it holds,
 * from the site's ETS project:
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
        throw new Error(`secure: true needs stack: knxultimate (site has ${stack || 'knx'})`)
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

module.exports = { siteSecure, secureOptions }
