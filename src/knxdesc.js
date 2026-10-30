/*
 * knxdesc.js - is there a KNXnet/IP gateway answering at ip:port?
 *
 * Sends a DESCRIPTION_REQUEST (0x0203) and waits for the DESCRIPTION_RESPONSE
 * (0x0204), as utils/knxdesc.py does. The request carries the NAT HPAI
 * 0.0.0.0:0 ("reply to the packet's source"), so it works over the internet
 * as well as on a LAN or VPN. A description takes no tunnel slot, so it is
 * safe against a gateway hamon (or anything else) is already connected to.
 *
 * Used by connection.js before the tunnel for a site that hasn't connected
 * recently: no reply means the site isn't online, and service.js blocks it.
 * tunnellingVersion reads what the reply says of the gateway: version 2 is
 * tunnelling v2, which offers TCP (site.js records it for the status page).
 */
const dgram = require('dgram')

// header (06 10, service 0x0203, length 14) + HPAI (8 bytes, UDP, 0.0.0.0:0)
const REQUEST = Buffer.from('06100203000e' + '0801' + '00000000' + '0000', 'hex')
const DESCRIPTION_RESPONSE = 0x0204
const SUPP_SVC_FAMILIES = 0x02
const FAMILY_TUNNELLING = 0x04

// one request; resolves the DESCRIPTION_RESPONSE, null on timeout or error
function ask(ip, port, timeout) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4')
        let done = false
        const finish = (reply) => {
            if (done) return
            done = true
            clearTimeout(timer)
            try { sock.close() } catch (e) { /* already closed */ }
            resolve(reply)
        }
        const timer = setTimeout(() => finish(null), timeout)
        sock.on('error', () => finish(null))
        sock.on('message', (msg) => {
            if (msg.length >= 8 && msg[0] === 0x06 && msg[1] === 0x10
                    && msg.readUInt16BE(2) === DESCRIPTION_RESPONSE) {
                finish(msg)
            } // anything else: keep waiting until the timeout
        })
        sock.send(REQUEST, Number(port), ip, (err) => { if (err) finish(null) })
    })
}

// the reply, if the gateway answers within `tries` requests of `timeout` ms each
async function query(ip, port, { timeout = 2500, tries = 2 } = {}) {
    for (let i = 0; i < tries; i++) {
        const reply = await ask(ip, port, timeout)
        if (reply) return reply
    }
    return null
}

// true if the gateway answers
async function describe(ip, port, options) {
    return (await query(ip, port, options)) != null
}

// the highest tunnelling version in a DESCRIPTION_RESPONSE, null if it lists
// none. After the 6-byte header come the DIBs (length, type, ...); the
// supported service families DIB (type 2) is (family, version) pairs
function tunnelVersionOf(msg) {
    let version = null
    for (let at = 6; at + 2 <= msg.length && msg[at] >= 2; at += msg[at]) {
        if (msg[at + 1] !== SUPP_SVC_FAMILIES) continue
        const end = Math.min(at + msg[at], msg.length)
        for (let f = at + 2; f + 1 < end; f += 2) {
            if (msg[f] === FAMILY_TUNNELLING) version = Math.max(version || 0, msg[f + 1])
        }
    }
    return version
}

// the gateway's tunnelling version; null if it doesn't answer or doesn't say
async function tunnellingVersion(ip, port, options) {
    const reply = await query(ip, port, options)
    return reply ? tunnelVersionOf(reply) : null
}

module.exports = { describe, tunnellingVersion, tunnelVersionOf, REQUEST }
