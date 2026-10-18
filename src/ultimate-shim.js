/*
 * ultimate-shim.js - KNXUltimate behind the knx 2.4.1 Connection API
 *
 * connection.js, mqwrite.js and knx.Datapoint only use a small part of a knx
 * Connection, so that is all this provides:
 *
 *   Connection({ ipAddr, ipPort, physAddr, suppress_ack_ldatareq, loglevel, site, log,
 *                secure, handlers: { connected, event, error } })
 *   .state            'idle' while connected (what connection.js tests for)
 *   .conntime         set while connected (knx.Datapoint autoread checks it)
 *   .write(ga, value, dptid, cb) / .writeRaw(ga, buf, bitlength, cb) / .read(ga, cb) / .Disconnect()
 *   events            connected, disconnected, error, and for each telegram the
 *                     same four the knx FSM emits, in the same order:
 *                     event_<dest>, <evt>_<dest>, <evt>, event
 *
 * Telegram payloads are passed on raw, so knx.Datapoint decodes them with knx's
 * own dptlib exactly as before, and writes are encoded with the same dptlib.
 *
 * Plain tunnelling over UDP, or with `secure` (from secrets.js) KNX Secure
 * tunnelling over TCP: tunnel user ID + password and the gateway's device
 * authentication code, given directly (no keyring). knxultimate only takes Data
 * Secure group keys from a keyring and resets them at every session start, so
 * the shim adds ours straight after that (secureEnsureKeyring), and checks on
 * every connect that they are really in the library's map: that relies on
 * knxultimate internals, and a library change would otherwise just stop Data
 * Secure GAs decoding without a word. A failed secure
 * authentication won't be fixed by retrying every 15 s, so it stops the
 * library's auto-reconnect and leaves the retry to hamon's restart back-off.
 *
 * Unlike knx, KNXUltimate throws where knx coped quietly, and those throws
 * would kill the worker, so the shim catches them:
 *   - no phyAddr in hamon.yml: knx used 15.15.15, KNXUltimate throws on undefined
 *   - read/write while not connected (e.g. an MQTT write during a reconnect):
 *     knx deferred it, KNXUltimate throws; here it is logged and dropped
 * It also drops gateway repeats (same sequence number as the last indication,
 * sent again when our ACK was lost), which would otherwise be stored twice.
 *
 * Only connection-level errors reach connection.js: each one arms hamon's
 * 15-min restart timer, which only a 'connected' clears, so a one-off send
 * error on a live tunnel would restart the worker 15 min later. And only the
 * first one per outage: knxultimate retries every ~15 s and errors each time,
 * which would flood error.log and keep pushing the restart timer back, so a
 * long outage (e.g. a changed DDNS address) would never get the worker restart.
 */

const { EventEmitter } = require('events')
const dgram = require('dgram')
const DPTLib = require('knx/src/dptlib')
const logger = require('./logger')

// knxultimate logs telegrams at 'info', which would flood hamon.log with what
// hamon already logs itself - so 'info' maps to 'warn'
const LOGLEVEL = { error: 'error', warn: 'warn', info: 'warn', debug: 'debug', trace: 'trace' }

// knxultimate's `loglevel` option sets the level of every logger in the
// process (KnxLog.setLogLevel), so with all sites in one thread each new client
// would reset every other site's level - a quiet ('error') or 'debug' site
// would set it for all. Instead the shared library loggers (dptlib, protocol)
// are set to 'warn' once, and each client's own logger - labelled with the site
// name through `setPrefix` - gets the site's level on its own
let sharedLevelSet = false
function setSharedLevel() {
    if (sharedLevelSet) return
    sharedLevelSet = true
    require('knxultimate/build/KnxLog').setLogLevel('warn')
}
function setClientLevel(client, level) {
    const log = client.sysLogger
    if (!log) return
    log.level = level
    for (const t of log.transports) t.level = level
}

// knxultimate's messages for a secure session the gateway or we refused
// 6.0.x says 'session rejected', 6.2+ 'rejected the session' (SESSION_STATUS 2)
const SECURE_AUTH_FAILED = /authentication failed|MAC verification failed|session rejected|rejected the session/i

class UltimateConnection extends EventEmitter {
    constructor(options) {
        super()
        const { KNXClient } = require('knxultimate')
        setSharedLevel()

        this.state = 'connecting'
        this.closing = false   // Disconnect() called
        this.errorForwarded = false   // first error of this outage passed on
        this.errorsSuppressed = 0
        this.options = options
        this.log = options.log || logger   // the site's logger (site.js)

        if (typeof options.handlers === 'object') {
            for (const [key, fn] of Object.entries(options.handlers)) {
                if (typeof fn === 'function') this.on(key, fn)
            }
        }

        this.localAddress((local) => this.start(KNXClient, local))
    }

    // knxultimate picks its local address from the first suitable interface,
    // which on a multi-homed host can be one the gateway isn't reached through
    // (e.g. a private eth1), so connects time out. Ask the kernel which source
    // address it would use for the gateway - a connected UDP socket sends nothing.
    // undefined if there is no route: knxultimate then picks for itself
    localAddress(callback) {
        const probe = dgram.createSocket('udp4')
        let done = false
        const finish = (local) => {
            if (done) return
            done = true
            try { probe.close() } catch (e) { }
            callback(local)
        }
        probe.on('error', () => finish(undefined))
        probe.connect(this.options.ipPort || 3671, this.options.ipAddr, () => {
            let local
            try { local = probe.address().address } catch (e) { }
            finish(local)
        })
    }

    // the route to the gateway may have changed (VPN up/down, DHCP), so check
    // again before knxultimate reconnects - it binds its new socket to
    // _options.localIPAddress, 5 s after the disconnect
    reprobe() {
        this.localAddress((local) => {
            if (!local || !this.client || this.closing) return
            const clientOptions = this.client._options
            if (clientOptions.localIPAddress !== local) {
                this.log.warn('%s local address %s -> %s', this.options.ipAddr,
                    clientOptions.localIPAddress, local)
                clientOptions.localIPAddress = local
            }
        })
    }

    start(KNXClient, localIPAddress) {
        try {
            this.startClient(KNXClient, localIPAddress)
        } catch (err) {
            // thrown inside the probe callback nothing would catch it
            this.disconnected('start failed')
            if (this.listenerCount('error') > 0) {
                this.emit('error', `start failed: ${(err && err.message) || err}`)
            }
        }
    }

    startClient(KNXClient, localIPAddress) {
        const options = this.options
        const secure = options.secure
        this.client = new KNXClient({
            hostProtocol: secure ? 'TunnelTCP' : 'TunnelUDP',
            ipAddr: options.ipAddr,
            ipPort: options.ipPort || 3671,
            physAddr: options.physAddr || '15.15.15',   // knx's default; secure: the gateway assigns it
            localIPAddress,
            suppress_ack_ldatareq: !!options.suppress_ack_ldatareq,
            loglevel: '',   // not process-wide: set on this client below
            setPrefix: options.site || 'KNXEngine',   // labels the library's lines
            autoReconnect: true,   // knx's FSM reconnects by itself too
            ...(secure ? {
                isSecureKNXEnabled: true,
                secureTunnelConfig: {
                    tunnelInterfaceIndividualAddress: secure.tunnelIA,
                    tunnelUserId: secure.userId,
                    tunnelUserPassword: secure.password,
                    deviceAuthenticationPassword: secure.deviceAuthCode,
                    // Data Secure keys without a keyring (knxultimate 6.2+)
                    ...(Object.keys(secure.groupKeys).length > 0 ? { groupKeys: this.groupKeyBuffers(secure.groupKeys) } : {}),
                },
            } : {}),
        })
        setClientLevel(this.client, LOGLEVEL[options.loglevel] || 'error')
        if (secure && Object.keys(secure.groupKeys).length > 0) this.groupKeys = secure.groupKeys

        this.client.on('connected', () => {
            if (secure) this.checkGroupKeys()
            this.state = 'idle'
            this.conntime = Date.now()
            delete this.lastSeq   // a new tunnel starts its sequence again
            if (this.errorsSuppressed > 0) {
                this.log.warn('%s back after %d more connection error(s) not logged',
                    this.options.ipAddr, this.errorsSuppressed)
            }
            this.errorForwarded = false
            this.errorsSuppressed = 0
            this.emit('connected')
        })
        this.client.on('disconnected', (reason) => {
            this.disconnected(reason)
            if (!this.closing) this.reprobe()
        })
        this.client.on('error', (err) => {
            const message = (err && err.message) || String(err)
            // synchronously: the library schedules its reconnect right after this
            if (options.secure && SECURE_AUTH_FAILED.test(message) && this.client._options.autoReconnect) {
                this.client._options.autoReconnect = false
                this.log.error('%s KNX Secure: %s - not retrying until the worker restarts; check the values from the ETS project',
                    this.options.ipAddr, message)
            }
            // a connection-level error is followed at once by a disconnect, so
            // judge it once the library has acted on it
            setImmediate(() => {
                if (this.closing) return
                if (this.client.isConnected()) {
                    this.log.warn('%s %s (still connected)', this.options.ipAddr, message)
                    return
                }
                if (this.errorForwarded) {
                    this.errorsSuppressed++
                    return
                }
                this.errorForwarded = true
                // an 'error' with no listener would throw and kill the worker
                if (this.listenerCount('error') > 0) this.emit('error', message)
            })
        })
        this.client.on('indication', (packet, echoed) => this.indication(packet, echoed))

        // Disconnect() was called before we got here
        if (this.closing) return
        this.client.Connect()
    }

    // Data Secure group keys ({ '<ga>': base64 }) as the 16-byte Buffers
    // secureTunnelConfig.groupKeys takes
    groupKeyBuffers(groupKeys) {
        return Object.fromEntries(Object.entries(groupKeys).map(([ga, key]) =>
            [ga, Buffer.from(key, 'base64').subarray(0, 16)]))
    }

    // after the session handshake (which runs secureEnsureKeyring): are all our
    // Data Secure keys in the map the library decrypts with? An error log, not
    // an 'error' event - plain GAs still flow, and a restart wouldn't fix it
    checkGroupKeys() {
        if (!this.groupKeys) return
        const client = this.client
        const map = client._secureGroupKeys
        const all = Object.entries(this.groupKeys)
        const missing = all.filter(([ga, key]) => {
            try {
                const have = map instanceof Map && map.get(client.secureParseGroupAddress(ga))
                return !(Buffer.isBuffer(have) && have.equals(Buffer.from(key, 'base64').subarray(0, 16)))
            } catch (e) {
                return true
            }
        }).map(([ga]) => ga)
        if (missing.length > 0) {
            this.log.error('%s KNX Secure: %d of %d Data Secure key(s) not in knxultimate\'s key map (%s) - those GAs won\'t decode; ' +
                'knxultimate internals may have changed', this.options.ipAddr, missing.length, all.length,
                missing.slice(0, 5).join(', ') + (missing.length > 5 ? ', ...' : ''))
        } else if (!this.groupKeysChecked) {
            this.log.info('%s KNX Secure: %d Data Secure key(s) in place', this.options.ipAddr, all.length)
        }
        this.groupKeysChecked = true
    }

    disconnected(reason) {
        if (this.state === 'disconnected') return
        this.state = 'disconnected'
        delete this.conntime
        this.emit('disconnected', reason)
    }

    indication(packet, echoed) {
        const cemi = packet && packet.cEMIMessage
        if (echoed || !cemi || !cemi.npdu) return   // knx doesn't echo our own writes either
        // device-to-device traffic (an ETS or visualisation scan): not group data
        if (cemi.control && cemi.control.addressType !== 1) return

        // a repeat of the last indication (our ACK was lost) - already passed on.
        // Only an equal number is a repeat: the library ACKs everything, so any
        // other number is a new telegram even if it is out of order
        const seq = packet.seqCounter
        if (seq != null) {
            if (seq === this.lastSeq) return
            this.lastSeq = seq
        }

        const npdu = cemi.npdu
        const evt = npdu.isGroupWrite ? 'GroupValue_Write'
            : npdu.isGroupResponse ? 'GroupValue_Response'
                : npdu.isGroupRead ? 'GroupValue_Read'
                    : null
        if (evt == null) return
        const src = cemi.srcAddress.toString()
        const dest = cemi.dstAddress.toString()
        const data = evt === 'GroupValue_Read' ? undefined : npdu.dataValue

        // same targets and order as knx FSM.emitEvent
        this.emit(`event_${dest}`, evt, src, data)
        this.emit(`${evt}_${dest}`, src, data)
        this.emit(evt, src, dest, data)
        this.emit('event', evt, src, dest, data)
    }

    write(grpaddr, value, dptid, callback) {
        if (grpaddr == null || value == null || !this.client) return
        try {
            const apdu = {}
            DPTLib.populateAPDU(value, apdu, dptid)   // knx's encoding, not knxultimate's
            this.client.writeRaw(grpaddr, apdu.data, apdu.bitlength)
        } catch (err) {
            return this.dropped('write', grpaddr, err)
        }
        if (typeof callback === 'function') setImmediate(callback)
    }

    // an already-encoded payload (knxultimate sites, see datapoint.js)
    writeRaw(grpaddr, buf, bitlength, callback) {
        if (grpaddr == null || !Buffer.isBuffer(buf) || !this.client) return
        try {
            this.client.writeRaw(grpaddr, buf, bitlength)
        } catch (err) {
            return this.dropped('write', grpaddr, err)
        }
        if (typeof callback === 'function') setImmediate(callback)
    }

    read(grpaddr, callback) {
        if (typeof callback === 'function') {
            const responseEvent = `GroupValue_Response_${grpaddr}`
            const binding = (src, data) => {
                this.off(responseEvent, binding)
                callback(src, data)
            }
            this.on(responseEvent, binding)
            setTimeout(() => this.off(responseEvent, binding), 3000)   // as knx
        }
        if (!this.client) return
        try {
            this.client.read(grpaddr)
        } catch (err) {
            this.dropped('read', grpaddr, err)
        }
    }

    // not an 'error' event: connection.js treats those as connection trouble
    dropped(what, grpaddr, err) {
        this.log.warn('%s %s %s dropped (%s): %s', this.options.ipAddr, what, grpaddr,
            this.state, (err && err.message) || err)
    }

    // state stays as it is until the library confirms, as with knx: connection.js
    // checks for 'idle' after calling this to decide whether to wait for
    // 'disconnected' (and so for the DISCONNECT_REQUEST to go out) before exiting.
    // The library gives up waiting for the gateway after 2 s
    Disconnect() {
        this.closing = true
        if (!this.client) return this.disconnected('Disconnect()')
        this.client.Disconnect()
            .catch(() => {})
            .finally(() => this.disconnected('Disconnect()'))
    }
}

// knx.Connection is called without `new`
function Connection(options) {
    return new UltimateConnection(options)
}

module.exports = { Connection, UltimateConnection }
