/*
 * sitestate.js - what service.js knows about each site, kept in
 * tmp/site-state.json so it survives an ha-mon restart and hamon-upload can
 * show it.
 *
 *   starting   a worker has been started, not connected yet
 *   connected  the KNX link is up
 *   down       stopped without connecting; waiting out the restart back-off
 *   blocked    stopped for a reason a retry won't fix (its DNS name doesn't
 *              resolve, or its gateway doesn't answer); no timed retry -
 *              only a change to the site's own hamon.yml entry or kpipe
 *              re-checks it
 *   misconfigured  its config is incomplete or wrong (KNX Secure values
 *              missing, GA file missing or empty), so it can't work; not
 *              started again until its config changes (or kpipe)
 *   disabled   enabled: false in hamon.yml
 *
 * The file is written on every change (tmp + rename, so a reader never sees a
 * half-written file) and carries the ha-mon pid and `running`, so a reader can
 * tell a current file from one left by a stopped ha-mon. tunnelVersion is the
 * gateway's own answer, kept across states: 2 = tunnelling v2, which offers TCP.
 */
const fs = require('fs')

// the hamon.yml fields that make a site restart when they change (service.js
// compareLoc), and that a block is tied to
const CHANGE_FIELDS = ['enabled', 'dns', 'port', 'device', 'logging', 'phyAddr',
                       'config', 'secure', 'tunnelIA', 'transport']
// fields added since blocks were first stored: in the fingerprint only when
// set, so the fingerprints of sites without them (and their blocks) don't change
const LATER_FIELDS = new Set(['transport'])

// identifies the config a site was blocked with: its fields, the stack it runs
// on and the GA file's mtime. A block carries over a restart only while this
// is unchanged
function fingerprint(loc, stack, mtime) {
    const f = {}
    for (const k of CHANGE_FIELDS) {
        if (loc[k] == null && LATER_FIELDS.has(k)) continue
        f[k] = loc[k] == null ? null : String(loc[k])
    }
    f.stack = stack
    f.mtime = mtime == null ? null : mtime
    return JSON.stringify(f)
}

// a site with no connection in this long gets its gateway checked (a KNXnet/IP
// DESCRIPTION request) before the tunnel, and is blocked if it doesn't answer
const PRECHECK_DAYS = 7

// does this site's worker check the gateway first? Yes unless it has connected
// within PRECHECK_DAYS - so a live site that happens to be down when its worker
// starts gets the normal back-off, never a block
function needsPrecheck(site, now = new Date(), days = PRECHECK_DAYS) {
    const last = site != null ? Date.parse(site.lastConnected) : NaN
    return isNaN(last) || now.getTime() - last > days * 24 * 60 * 60 * 1000
}

// states a site is held in, with no timed retry, until its config changes
const HELD = ['blocked', 'misconfigured']

class SiteState {
    constructor(file, { now = () => new Date(), pid = process.pid } = {}) {
        this.file = file
        this.now = now
        this.pid = pid
        this.sites = {}
    }

    // the previous run's state; a missing or unreadable file starts empty
    load() {
        try {
            const doc = JSON.parse(fs.readFileSync(this.file, 'utf8'))
            if (doc && typeof doc.sites === 'object' && doc.sites !== null) {
                this.sites = doc.sites
                return true
            }
        } catch (e) {
            // first run, or a damaged file: start as before this file existed
        }
        this.sites = {}
        return false
    }

    get(name) {
        return this.sites[name]
    }

    // change a site's state; `since` moves only when the state itself changes
    set(name, state, extra = {}) {
        const old = this.sites[name] || {}
        const now = this.now().toISOString()
        const s = {
            state,
            since: old.state === state ? old.since : now,
            failures: old.failures || 0,
            lastConnected: old.lastConnected || null,
            ...extra,
        }
        if (old.tunnelVersion != null) s.tunnelVersion = old.tunnelVersion
        if (state === 'connected') {
            s.failures = 0
            s.lastConnected = now
        }
        // these only mean something in the state that set them
        if (!HELD.includes(state)) { delete s.reason; delete s.detail; delete s.fingerprint }
        if (state !== 'down') delete s.nextRetry
        this.sites[name] = s
        return s
    }

    // a fact about the site that doesn't change its state
    note(name, fields) {
        if (this.sites[name]) Object.assign(this.sites[name], fields)
    }

    // drop sites no longer in hamon.yml
    retain(names) {
        for (const n of Object.keys(this.sites)) {
            if (!names.includes(n)) delete this.sites[n]
        }
    }

    // a blocked or misconfigured site whose config hasn't changed since stays
    // that way across a restart
    stillBlocked(name, fp) {
        const s = this.sites[name]
        return s != null && HELD.includes(s.state) && s.fingerprint === fp
    }

    save(running = true) {
        const doc = { updated: this.now().toISOString(), pid: this.pid, running, sites: this.sites }
        const tmp = `${this.file}.tmp`
        try {
            fs.writeFileSync(tmp, JSON.stringify(doc, null, 1) + '\n')
            fs.renameSync(tmp, this.file)
        } catch (e) {
            return e // reported by the caller; hamon carries on without the file
        }
        return null
    }
}

module.exports = { SiteState, fingerprint, needsPrecheck, PRECHECK_DAYS, CHANGE_FIELDS, HELD }
