/*
 * dedupe.js - store a chatty GA's repeats less often (top-level `dedupe:` in
 * hamon.yml, seconds; a location's own `dedupe:` overrides it, 0 = off)
 *
 * Per GA: a value is written when it differs from the last value written, or
 * when `window` ms have passed since then. Anything else is held as pending
 * (only the latest) and written at last-written + window with its own time, or
 * just before the next value that is written now. So the last value before a
 * quiet spell or a change is never lost, and a change is never delayed. Dashboards average per time bucket and join gaps, so they draw the
 * same thing - see docs/chatty-filter.md.
 *
 * write(time, args) does the store: time is a Date for a held value written
 * late, null for one written as it arrives (InfluxDB stamps it).
 */
function createDedupe(window, write, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    const gas = new Map() // key -> { value, at, pending: { value, at, args }, timer }

    function flush(key) {
        const g = gas.get(key)
        if (!g || !g.pending) return
        const p = g.pending
        g.pending = null
        g.timer = null
        g.value = p.value
        g.at = p.at
        write(new Date(p.at), p.args)
    }

    // returns true if written now, false if held
    function push(key, value, args) {
        const t = now()
        const g = gas.get(key)
        if (g === undefined || value !== g.value || t - g.at >= window) {
            // a held repeat goes first, so a step still draws as a step
            if (g && g.timer) clearTimer(g.timer)
            if (g && g.pending) flush(key)
            gas.set(key, { value, at: t, pending: null, timer: null })
            write(null, args)
            return true
        }
        g.pending = { value, at: t, args }
        if (!g.timer) g.timer = setTimer(() => flush(key), Math.max(0, g.at + window - t))
        return false
    }

    // write every held value (the site is stopping) and forget them all
    function flushAll() {
        for (const [key, g] of gas) {
            if (g.timer) clearTimer(g.timer)
            flush(key)
        }
        gas.clear()
    }

    return { push, flushAll }
}

// the window in ms for a location: its own dedupe:, else the top-level one,
// else off (0). Anything not a positive number is off
function effective(siteDedupe, topDedupe) {
    const s = siteDedupe != null ? siteDedupe : topDedupe
    const n = Number(s)
    return Number.isFinite(n) && n > 0 ? n * 1000 : 0
}

module.exports = { createDedupe, effective }
