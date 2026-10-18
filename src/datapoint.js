/*
 * datapoint.js - knx.Datapoint's job done with KNXUltimate's dptlib
 *
 * Used for sites on the knxultimate stack (knx sites keep knx.Datapoint).
 * Covers the part of knx.Datapoint hamon uses:
 *   .current_value    the decoded value of the last Write/Response telegram
 *                     (undefined if the payload doesn't decode for the DPT)
 *   .write(value)     encode and send a GroupValue_Write (raw, so the KNX
 *                     stack's own encoder isn't involved)
 *   .read(callback)   send a GroupValue_Read; callback(src, value)
 * Works over either stack: both connections emit event_<ga> with the raw
 * payload and have writeRaw()/read().
 *
 * The type name and unit don't come from here - see dptnames.js.
 *
 * Writes: KNXUltimate encodes out-of-range values anyway (5.001 128 -> 50%,
 * a negative DPT7 -> 0), so write() checks dptrange.js first.
 */
const { EventEmitter } = require('events')
const DPTLib = require('knxultimate/build/dptlib')
const { writeError } = require('./dptrange')

class Datapoint extends EventEmitter {
    constructor (options, conn) {
        if (options == null || options.ga == null) throw new Error('must supply at least { ga, dpt }')
        super()
        this.options = options
        this.dptid = options.dpt || 'DPT1.001'   // as knx
        this.dpt = null
        try {
            this.dpt = DPTLib.resolve(this.dptid)
        } catch (e) {
            // left undecoded (current_value stays undefined), not a crash
        }
        this.current_value = null
        if (conn) this.bind(conn)
    }

    bind (conn) {
        this.conn = conn
        conn.on(`event_${this.options.ga}`, (evt, src, buf) => {
            if ((evt === 'GroupValue_Write' || evt === 'GroupValue_Response') && buf) {
                const value = this.decode(buf)
                // a telegram that can't be stored: tell the site (it logs it)
                if (value == null && this.dpt !== null) this.emit('invalid', src, buf, this.invalidReason(buf))
                this.update(value)
            }
        })
    }

    // why a payload didn't decode
    invalidReason (buf) {
        if (this.isInvalid9(buf)) return 'device reports invalid data (7FFFh)'
        return `payload doesn't fit ${this.dptid} - check the GA's DPT in ETS`
    }

    // DPT 9: 7FFFh is the spec's 'invalid data' value, not 670760.96
    // (XKNX rejects it too), so it isn't stored
    isInvalid9 (buf) {
        return /^DPT9(\.|$)/.test(this.dptid) && buf.length === 2 && buf.readUInt16BE(0) === 0x7fff
    }

    decode (buf) {
        if (this.dpt === null) return undefined
        if (this.isInvalid9(buf)) return undefined
        try {
            return DPTLib.fromBuffer(buf, this.dpt)
        } catch (e) {
            return undefined
        }
    }

    update (value) {
        if (this.current_value === value) return
        const old = this.current_value
        this.current_value = value
        this.emit('change', old, value, this.options.ga)
    }

    // throws (as knx.Datapoint did) if the value can't be sent for this DPT
    write (value) {
        if (!this.conn) throw new Error('must supply a valid KNX connection to bind to')
        if (this.dpt === null) throw new Error(`unsupported DPT ${this.dptid}`)
        const err = writeError(this.dptid, value)
        if (err) throw new Error(err)
        const apdu = {}
        DPTLib.populateAPDU(value, apdu, this.dptid)
        if (!Buffer.isBuffer(apdu.data)) throw new Error(`${this.dptid} cannot encode ${JSON.stringify(value)}`)
        this.conn.writeRaw(this.options.ga, apdu.data, apdu.bitlength, () => this.update(value))
    }

    read (callback) {
        if (!this.conn) throw new Error('must supply a valid KNX connection to bind to')
        this.conn.read(this.options.ga, (src, buf) => {
            if (typeof callback === 'function') callback(src, this.decode(buf))
        })
    }

    toString () {
        return `(${this.options.ga}) ${this.current_value}`
    }
}

module.exports = { Datapoint }
