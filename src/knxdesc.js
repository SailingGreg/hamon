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
 */
const dgram = require('dgram')

// header (06 10, service 0x0203, length 14) + HPAI (8 bytes, UDP, 0.0.0.0:0)
const REQUEST = Buffer.from('06100203000e' + '0801' + '00000000' + '0000', 'hex')
const DESCRIPTION_RESPONSE = 0x0204

// one request; resolves true on a DESCRIPTION_RESPONSE, false on timeout or error
function ask(ip, port, timeout) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4')
        let done = false
        const finish = (ok) => {
            if (done) return
            done = true
            clearTimeout(timer)
            try { sock.close() } catch (e) { /* already closed */ }
            resolve(ok)
        }
        const timer = setTimeout(() => finish(false), timeout)
        sock.on('error', () => finish(false))
        sock.on('message', (msg) => {
            if (msg.length >= 8 && msg[0] === 0x06 && msg[1] === 0x10
                    && msg.readUInt16BE(2) === DESCRIPTION_RESPONSE) {
                finish(true)
            } // anything else: keep waiting until the timeout
        })
        sock.send(REQUEST, Number(port), ip, (err) => { if (err) finish(false) })
    })
}

// true if the gateway answers within `tries` requests of `timeout` ms each
async function describe(ip, port, { timeout = 2500, tries = 2 } = {}) {
    for (let i = 0; i < tries; i++) {
        if (await ask(ip, port, timeout)) return true
    }
    return false
}

module.exports = { describe, REQUEST }
