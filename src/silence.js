/*
 * silence.js - a site that is connected but sends nothing
 *
 * hamon sees every telegram, so it can tell "connected and working" from
 * "connected but silent" itself (until now only freshness-detector.sh could,
 * from InfluxDB). Each site's worker reports the time of its last telegram
 * every minute; service.js passes it here and acts on the answer:
 *
 *   silent for the site's threshold   restart (container restart for a
 *                                     container site, then re-init), at once
 *   still silent                      again after cooldown, 2x ... cooldown_max
 *   data again                        the spell ends; the next starts at 1
 *   still silent after max_restarts   stopped: no more restarts this spell, logged
 *   (6 default)                       once - a bus that is dead or quiet at the
 *                                     site, which a restart can't fix
 *   a new site (first connected less  not restarted: its normal traffic isn't
 *   than `grace` ago, 24 h default)   known yet (the detector's grace)
 *   the server's uplink is down       hold: no restart, the spell is kept
 *                                     (see uplink.js)
 *
 * Thresholds come from freshness-thresholds.conf, the file the detector reads
 * (one `<key> <minutes>` per line: default, cooldown, cooldown_max, and a
 * threshold per site; it names sites, so it stays out of git; max_restarts is
 * a count, not minutes, 0 = never stop). It is read on
 * every check, so an edit applies at once, as it does for the detector.
 *
 * The top-level `silence:` key in hamon.yml says what is done: off (the
 * default), report (log what would be done, so it can run beside the
 * detector) or act.
 */
const fs = require('fs')

const MODES = ['off', 'report', 'act']

function mode(doc) {
    const m = doc != null ? doc.silence : undefined
    return MODES.includes(m) ? m : 'off'
}

// { default, cooldown, cooldownMax, grace, maxRestarts, sites: { name: minutes } } in minutes, or
// null without the three reserved keys (as the detector, which then refuses to run)
function loadThresholds(file) {
    let text
    try {
        text = fs.readFileSync(file, 'utf8')
    } catch (e) {
        return null
    }
    const conf = {}
    const sites = {}
    for (const raw of text.split('\n')) {
        const [key, mins] = raw.split('#')[0].trim().split(/\s+/)
        if (!key || !/^\d+$/.test(mins || '')) continue
        if (['default', 'cooldown', 'cooldown_max', 'grace', 'max_restarts'].includes(key)) conf[key] = Number(mins)
        else sites[key] = Number(mins)
    }
    if (conf.default == null || conf.cooldown == null || conf.cooldown_max == null) return null
    return { default: conf.default, cooldown: conf.cooldown, cooldownMax: conf.cooldown_max,
             grace: conf.grace != null ? conf.grace : 1440,
             maxRestarts: conf.max_restarts != null ? conf.max_restarts : 6, sites }
}

// the wait after restart n of a spell, in minutes
function cooldown(t, n) {
    return Math.min(t.cooldown * 2 ** (n - 1), t.cooldownMax)
}

class Silence {
    // thresholds(): as loadThresholds; uplink(): a reason string while the uplink is down
    constructor({ thresholds, uplink = () => null, now = () => Date.now() }) {
        this.thresholds = thresholds
        this.uplink = uplink
        this.now = now
        this.spells = {} // name -> { n, t, since }: restarts this spell, the last one's time
        this.held = {}   // name -> since when it's held for the uplink (logged once)
        this.graced = {} // name -> since when a silent new site is left alone (logged once)
    }

    // carry a spell over an ha-mon restart, from the site's `silent` record in
    // the state file ({ since, restarts, next }); ms is how long ha-mon was
    // stopped, which doesn't count towards the next restart
    restore(name, silent, ms = 0) {
        const t = this.thresholds()
        if (t == null || silent == null || !(silent.restarts > 0) || this.spells[name] != null) return
        const since = Date.parse(silent.since), next = Date.parse(silent.next)
        if (isNaN(since)) return
        const n = silent.restarts
        const last = isNaN(next) ? this.now() : next - cooldown(t, n) * 60000 + ms
        this.spells[name] = { n, t: last, since: since + ms, stopped: silent.stopped === true }
    }

    // the site's last telegram (ms, or null for none since it connected), and
    // when it first connected if it's on record (ms) ->
    // { do: 'restart' | 'stop' | 'stopped' | 'hold' | 'grace' | 'end' | 'wait' | null, ... }
    check(name, last, firstConnected = null) {
        const t = this.thresholds()
        if (t == null || last == null) return { do: null }
        const now = this.now()
        const age = Math.floor((now - last) / 60000)
        const thresh = t.sites[name] != null ? t.sites[name] : t.default
        const spell = this.spells[name]
        if (age < thresh) {
            delete this.held[name]
            delete this.graced[name]
            if (spell == null) return { do: null }
            delete this.spells[name]
            return { do: 'end', restarts: spell.n, minutes: Math.round((now - spell.since) / 60000) }
        }
        if (firstConnected != null && spell == null && now - firstConnected < t.grace * 60000) {
            const first = this.graced[name] == null
            if (first) this.graced[name] = now
            return { do: 'grace', age, thresh, until: firstConnected + t.grace * 60000, first, since: this.graced[name] }
        }
        delete this.graced[name]
        if (spell != null && t.maxRestarts > 0 && spell.n >= t.maxRestarts) {
            // the restarts haven't helped: wait out the last cooldown, then stop
            const wait = cooldown(t, spell.n)
            if (!spell.stopped && now - spell.t < wait * 60000) return { do: 'wait', age, thresh, n: spell.n, next: spell.t + wait * 60000 }
            const first = !spell.stopped
            spell.stopped = true
            return { do: first ? 'stop' : 'stopped', age, thresh, n: spell.n }
        }
        const up = this.uplink()
        if (up != null) {
            const first = this.held[name] == null
            if (first) this.held[name] = now
            return { do: 'hold', age, thresh, why: up, first, since: this.held[name] }
        }
        delete this.held[name]
        if (spell != null) {
            const wait = cooldown(t, spell.n)
            if (now - spell.t < wait * 60000) return { do: 'wait', age, thresh, n: spell.n, next: spell.t + wait * 60000 }
        }
        const n = spell != null ? spell.n + 1 : 1
        this.spells[name] = { n, t: now, since: spell != null ? spell.since : now }
        return { do: 'restart', age, thresh, n, next: now + cooldown(t, n) * 60000 }
    }

    forget(name) {
        delete this.spells[name]
        delete this.held[name]
        delete this.graced[name]
    }
}

module.exports = { Silence, loadThresholds, cooldown, mode, MODES }
