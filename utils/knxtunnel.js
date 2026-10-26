#!/usr/bin/env node
/*
 * knxtunnel.js - open a listen-only KNXnet/IP tunnel to a site's gateway, next
 * to hamon's, and report how it behaves: connects, drops, errors and the
 * longest gap between telegrams. Nothing is sent to the bus and hamon.yml is
 * not changed, so it can try a connection hamon doesn't use yet (e.g. TCP on a
 * tunnelling v2 gateway) across a planned VPN reconnect, with hamon's own
 * tunnel on the same gateway as the comparison.
 *
 *   node utils/knxtunnel.js [--tcp] [-t seconds] [-f hamon.yml] <site|host:port>
 *
 *   --tcp      tunnel over TCP (needs tunnelv2 in knxdesc, and for a VPN
 *              container site a TCP forward in the container); default UDP
 *   -t         how long to listen (default 120 s); Ctrl-C ends it early
 *
 * It takes one more tunnel on the gateway for the duration (a gateway with
 * no free tunnel answers "no more connections") and disconnects cleanly at
 * the end. Reconnects by itself like hamon does, so a drop shows its length.
 */
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const { KNXClient, KNXClientEvents } = require('knxultimate')

const args = process.argv.slice(2)
let tcp = false, secs = 120, file = path.join(__dirname, '..', 'hamon.yml'), target
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tcp') tcp = true
    else if (args[i] === '-t') secs = Number(args[++i])
    else if (args[i] === '-f') file = args[++i]
    else target = args[i]
}
if (!target || !(secs > 0)) {
    console.error('usage: knxtunnel.js [--tcp] [-t seconds] [-f hamon.yml] <site|host:port>')
    process.exit(2)
}

// a site name from hamon.yml, else host:port
let host, port, phyAddr = '15.15.15'
const loc = Object.values(yaml.load(fs.readFileSync(file, 'utf8')).locations || {})
    .find((l) => l && l.name === target)
if (loc) {
    host = String(loc.dns); port = Number(loc.port) || 3671
    if (loc.phyAddr) phyAddr = String(loc.phyAddr)
} else {
    [host, port] = target.split(':'); port = Number(port) || 3671
}

const t0 = Date.now()
const stamp = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(stamp(), ...a)
let telegrams = 0, last = null, maxGap = 0, maxGapAt = null, connects = 0, drops = 0, errors = 0
let downSince = null, down = 0

const client = new KNXClient({
    hostProtocol: tcp ? 'TunnelTCP' : 'TunnelUDP',
    ipAddr: host, ipPort: port, physAddr: phyAddr,
    autoReconnect: true, loglevel: 'error', setPrefix: 'knxtunnel',
})
client.on(KNXClientEvents.connected, () => {
    connects++
    if (downSince) { down += Date.now() - downSince; log(`reconnected after ${((Date.now() - downSince) / 1000).toFixed(1)} s`); downSince = null }
    else log(`connected (${tcp ? 'TCP' : 'UDP'}) to ${host}:${port}`)
})
client.on(KNXClientEvents.disconnected, (why) => {
    if (finishing) return
    drops++; downSince = downSince || Date.now()
    log('DROPPED:', why)
})
client.on(KNXClientEvents.error, (err) => { errors++; log('error:', (err && err.message) || err) })
client.on(KNXClientEvents.indication, () => {
    const now = Date.now()
    if (last != null && now - last > maxGap) { maxGap = now - last; maxGapAt = stamp() }
    last = now; telegrams++
})

let finishing = false
async function finish() {
    if (finishing) return
    finishing = true
    if (downSince) down += Date.now() - downSince
    try { await client.Disconnect() } catch (e) { }
    const s = ((Date.now() - t0) / 1000).toFixed(0)
    console.log(`${target} ${tcp ? 'TCP' : 'UDP'}: ${s} s, ${telegrams} telegrams, longest gap ${(maxGap / 1000).toFixed(1)} s` +
        `${maxGapAt ? ` (ending ${maxGapAt})` : ''}; ${connects} connect(s), ${drops} drop(s), down ${(down / 1000).toFixed(1)} s, ${errors} error(s)`)
    setTimeout(() => process.exit(drops > 0 || connects === 0 ? 1 : 0), 1000)
}
setTimeout(finish, secs * 1000)
process.on('SIGINT', finish)
log(`${target}: listening for ${secs} s`)
client.Connect()
