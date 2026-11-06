/*
 * uplink.js - is the server's own uplink down? Read from utils/netprobe.py's log
 *
 * A restart can fix a site or its path, not the server's uplink, and one made
 * while the uplink is down only uses up the silence cooldown (2026-11-04: a
 * 10-min provider outage). The rule is the one freshness-detector.sh and
 * utils/netprobe-report.py use: over the last `window` seconds of LOSS lines, a
 * target is down if it lost half or more of its probes, and the uplink is
 * down if half or more of all targets are. The probes per target come from
 * its last minute SUMMARY line. No netprobe log line in the last 2 min (not
 * running): not down, so a stopped probe never stops recovery.
 */
const fs = require('fs')
const path = require('path')

const TAIL = 64 * 1024 // the last few minutes of the log
const STALE = 120 * 1000

const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const stamp = (s) => { // netprobe writes local time, 'YYYY-MM-DD HH:MM:SS'
    const t = new Date(s.replace(' ', 'T'))
    return isNaN(t) ? null : t.getTime()
}

function tail(file) {
    let fd
    try {
        fd = fs.openSync(file, 'r')
        const size = fs.fstatSync(fd).size
        const len = Math.min(size, TAIL)
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, size - len)
        const lines = buf.toString().split('\n')
        if (len < size) lines.shift() // a part line
        return lines
    } catch (e) {
        return []
    } finally {
        if (fd != null) fs.closeSync(fd)
    }
}

// "<down>/<targets> targets down in the last <window>s: <labels>", or null
function uplinkDown(dir, { window = 30, now = Date.now() } = {}) {
    const today = new Date(now)
    const lines = [...tail(path.join(dir, `netprobe-${day(new Date(now - 86400000))}.log`)),
                   ...tail(path.join(dir, `netprobe-${day(today)}.log`))]
    const end = now - 3000 // a knx probe is logged lost a couple of seconds late
    const start = end - window * 1000
    let rate = null
    let last = null
    const lost = {}
    for (const l of lines) {
        const t = stamp(l.slice(0, 19))
        if (t == null) continue
        if (t > now) break
        last = t
        const rest = l.slice(20)
        if (rest.startsWith('SUMMARY ')) {
            rate = {}
            for (const part of rest.slice(8).split(' | ')) {
                const f = part.trim().split(/\s+/)
                if (f.length < 2 || !f[1].includes('/') || /^(rx_|udp_)/.test(f[0])) continue
                const n = parseInt(f[1].split('/')[1], 10)
                if (n > 0) rate[f[0]] = n
            }
        } else if (rest.startsWith('LOSS ') && t > start && t <= end) {
            for (const x of rest.slice(5).trim().split(/\s+/)) lost[x] = (lost[x] || 0) + 1
        }
    }
    if (rate == null || Object.keys(rate).length === 0 || last == null || now - last > STALE) return null
    const targets = Object.keys(rate)
    const down = targets.filter((x) => (lost[x] || 0) * 2 >= Math.max(1, Math.floor(rate[x] * window / 60))).sort()
    if (down.length * 2 < targets.length) return null
    return `${down.length}/${targets.length} targets down in the last ${window}s: ${down.join(',')}`
}

module.exports = { uplinkDown }
