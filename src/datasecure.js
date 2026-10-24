/*
 * datasecure.js - KNX Data Secure group telegrams on a plain tunnel
 *
 * Data Secure is application-layer security: a secured group telegram is an
 * ordinary cEMI frame whose APDU is S-A_Data (APCI 0x3F1), so it passes any
 * interface and a plain (not KNX IP Secure) tunnel unchanged. Receiving it
 * needs only the group key: the APDU after the APCI is
 *
 *   SCF (1, 0x10 = authenticated + encrypted S-A_Data) | SeqNr (6, in clear) |
 *   encrypted APDU | MAC (4)
 *
 * decrypted with AES-CTR and checked with AES-CBC-MAC (the source and
 * destination addresses and the frame's control bits are in the blocks).
 * Replay: the sender's SeqNr must be above the last valid one from that
 * sender; a listener starts with none, so it accepts the first from each
 * sender (as a device starts at 0). Sync requests only matter for sending.
 *
 * knxultimate decrypts Data Secure only on a KNX IP Secure connection; this is
 * the same steps for a plain tunnel, with knxultimate's AES primitives. A
 * telegram that decrypts is put back in the cEMI as the plain APDU, so the
 * caller handles it like any other. Receive only: nothing is ever sent.
 */

const KNXDataBuffer = require('knxultimate/build/protocol/KNXDataBuffer').default
const { decryptCtr, calculateMessageAuthenticationCodeCBC, macEquals } = require('knxultimate/build/secure/security_primitives')
const C = require('knxultimate/build/secure/secure_knx_constants')

const GROUP = 1   // cemi.control.addressType for a group address

// is this cEMI's APDU S-A_Data (APCI 0x3F1)?
function isSecured(cemi) {
    const npdu = cemi && cemi.npdu
    return !!npdu && (npdu.tpci & 0x03) === C.APCI_SEC.HIGH && (npdu.apci & 0xff) === C.APCI_SEC.LOW
}

// '1/2/3' -> 16-bit group address
function gaNumber(ga) {
    const p = String(ga).split('/').map(Number)
    if (p.length === 3) return (p[0] << 11) | (p[1] << 8) | p[2]
    if (p.length === 2) return (p[0] << 11) | p[1]
    return Number(ga)
}

class DataSecure {
    // groupKeys: { '<ga>': base64 or 32 hex chars } (as .hamon-secrets.json holds them)
    constructor(groupKeys) {
        this.keys = new Map()
        for (const [ga, key] of Object.entries(groupKeys || {})) {
            const buf = /^[0-9a-f]{32}$/i.test(key) ? Buffer.from(key, 'hex') : Buffer.from(key, 'base64')
            if (buf.length < 16) throw new Error(`Data Secure key for ${ga} is not 16 bytes`)
            this.keys.set(gaNumber(ga), buf.subarray(0, 16))
        }
        this.lastSeq = new Map()   // sender IA -> last valid SeqNr (BigInt)
    }

    get size() {
        return this.keys.size
    }

    // a group telegram's cEMI: 'plain' (not secured - leave it), 'decrypted'
    // (cemi.npdu now holds the plain APDU), or { drop: why } with why one of
    // 'no key', 'not S-A_Data' (SCF other than 0x10), 'short', 'MAC', 'replay'
    open(cemi) {
        if (!isSecured(cemi) || cemi.control.addressType !== GROUP) return 'plain'
        const src = cemi.srcAddress.get()
        const dst = cemi.dstAddress.get()
        const key = this.keys.get(dst)
        if (!key) return { drop: 'no key' }
        const npdu = cemi.npdu
        const data = npdu.dataBuffer ? npdu.dataBuffer.value : Buffer.alloc(0)
        if (data.length < 1 + C.SECURE_SEQ_LEN + C.MAC_LEN_SHORT) return { drop: 'short' }
        const scf = data[0]
        if (scf !== C.SCF_ENCRYPTION_S_A_DATA) return { drop: 'not S-A_Data' }
        const seq = data.subarray(1, 1 + C.SECURE_SEQ_LEN)
        const rest = data.subarray(1 + C.SECURE_SEQ_LEN)
        const encMac = rest.subarray(-C.MAC_LEN_SHORT)
        const encPayload = rest.subarray(0, rest.length - C.MAC_LEN_SHORT)
        const addr = Buffer.from([(src >> 8) & 0xff, src & 0xff, (dst >> 8) & 0xff, dst & 0xff])
        const [payload, mac] = decryptCtr(key, Buffer.concat([seq, addr, C.DATA_SECURE_CTR_SUFFIX]), encMac, encPayload)
        const flags2 = cemi.control.toBuffer()[1] & C.CEMI.CTRL2_RELEVANT_MASK
        const block0 = Buffer.concat([seq, addr, Buffer.from([0x00, flags2,
            (C.TPCI_DATA << 2) + C.APCI_SEC.HIGH, C.APCI_SEC.LOW, 0x00, payload.length])])
        const check = calculateMessageAuthenticationCodeCBC(key, Buffer.from([scf]), payload, block0).subarray(0, C.MAC_LEN_SHORT)
        if (!macEquals(check, mac)) return { drop: 'MAC' }
        const n = BigInt(seq.readUIntBE(0, C.SECURE_SEQ_LEN))
        const last = this.lastSeq.get(src)
        if (last !== undefined && n <= last) return { drop: 'replay' }
        this.lastSeq.set(src, n)
        // the plain APDU: TPCI/APCI high bits, APCI low byte (with a 6-bit
        // value), then any data bytes
        npdu.tpci = payload.length > 0 ? payload[0] & 0x03 : 0
        npdu.apci = payload.length > 1 ? payload[1] : 0
        npdu.data = payload.length > 2 ? new KNXDataBuffer(payload.subarray(2)) : null
        return 'decrypted'
    }
}

module.exports = { DataSecure, isSecured, gaNumber }
