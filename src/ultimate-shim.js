/*
 * ultimate-shim.js - KNXUltimate behind the knx 2.4.1 Connection API
 *
 * connection.js, mqwrite.js and knx.Datapoint only use a small part of a knx
 * Connection, so that is all this provides:
 *
 *   Connection({ ipAddr, ipPort, physAddr, suppress_ack_ldatareq, loglevel,
 *                handlers: { connected, event, error } })
 *   .state            'idle' while connected (what connection.js tests for)
 *   .conntime         set while connected (knx.Datapoint autoread checks it)
 *   .write(ga, value, dptid, cb) / .read(ga, cb) / .Disconnect()
 *   events            connected, disconnected, error, and for each telegram the
 *                     same four the knx FSM emits, in the same order:
 *                     event_<dest>, <evt>_<dest>, <evt>, event
 *
 * Telegram payloads are passed on raw, so knx.Datapoint decodes them with knx's
 * own dptlib exactly as before, and writes are encoded with the same dptlib.
 *
 * Plain tunnelling over UDP only for now; KNX Secure (TCP) comes later.
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
 * error on a live tunnel would restart the worker 15 min later.
 */

const { EventEmitter } = require('events')
const dgram = require('dgram')
const DPTLib = require('knx/src/dptlib')
const logger = require('./logger')

// knxultimate logs telegrams at 'info', which would flood hamon.log with what
// hamon already logs itself - so 'info' maps to 'warn'
const LOGLEVEL = { error: 'error', warn: 'warn', info: 'warn', debug: 'debug', trace: 'trace' }

class UltimateConnection extends EventEmitter {
    constructor(options) {
        super()
        const { KNXClient } = require('knxultimate')

        this.state = 'connecting'
        this.closing = false   // Disconnect() called
        this.options = options

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
                logger.warn('%s local address %s -> %s', this.options.ipAddr,
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
        this.client = new KNXClient({
            hostProtocol: 'TunnelUDP',
            ipAddr: options.ipAddr,
            ipPort: options.ipPort || 3671,
            physAddr: options.physAddr || '15.15.15',   // knx's default
            localIPAddress,
            suppress_ack_ldatareq: !!options.suppress_ack_ldatareq,
            loglevel: LOGLEVEL[options.loglevel] || 'error',
            autoReconnect: true,   // knx's FSM reconnects by itself too
        })

        this.client.on('connected', () => {
            this.state = 'idle'
            this.conntime = Date.now()
            delete this.lastSeq   // a new tunnel starts its sequence again
            this.emit('connected')
        })
        this.client.on('disconnected', (reason) => {
            this.disconnected(reason)
            if (!this.closing) this.reprobe()
        })
        this.client.on('error', (err) => {
            const message = (err && err.message) || String(err)
            // a connection-level error is followed at once by a disconnect, so
            // judge it once the library has acted on it
            setImmediate(() => {
                if (this.closing) return
                if (this.client.isConnected()) {
                    logger.warn('%s %s (still connected)', this.options.ipAddr, message)
                    return
                }
                // an 'error' with no listener would throw and kill the worker
                if (this.listenerCount('error') > 0) this.emit('error', message)
            })
        })
        this.client.on('indication', (packet, echoed) => this.indication(packet, echoed))

        // Disconnect() was called before we got here
        if (this.closing) return
        this.client.Connect()
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
        logger.warn('%s %s %s dropped (%s): %s', this.options.ipAddr, what, grpaddr,
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
