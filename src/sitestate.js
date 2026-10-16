/*
 * sitestate.js - what service.js knows about each site, kept in
 * tmp/site-state.json so it survives an ha-mon restart and hamon-upload can
 * show it.
 *
 *   starting   a worker has been started, not connected yet
 *   connected  the KNX link is up
 *   down       stopped without connecting; waiting out the restart back-off
 *   blocked    stopped for a reason a retry won't fix (DNS); no timed retry -
 *              only a change to the site's own hamon.yml entry or kpipe
 *              re-checks it
 *   disabled   enabled: false in hamon.yml
 *
 * The file is written on every change (tmp + rename, so a reader never sees a
 * half-written file) and carries the ha-mon pid and `running`, so a reader can
 * tell a current file from one left by a stopped ha-mon.
 */
const fs = require('fs')

// the hamon.yml fields that make a site restart when they change (service.js
// compareLoc), and that a block is tied to
const CHANGE_FIELDS = ['enabled', 'dns', 'port', 'device', 'logging', 'phyAddr',
                       'config', 'secure', 'tunnelIA']

// identifies the config a site was blocked with: its fields, the stack it runs
// on and the GA file's mtime. A block carries over a restart only while this
// is unchanged
function fingerprint(loc, stack, mtime) {
    const f = {}
    for (const k of CHANGE_FIELDS) f[k] = loc[k] == null ? null : String(loc[k])
    f.stack = stack
    f.mtime = mtime == null ? null : mtime
    return JSON.stringify(f)
}

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
        if (state === 'connected') {
            s.failures = 0
            s.lastConnected = now
        }
        // these only mean something in the state that set them
        if (state !== 'blocked') { delete s.reason; delete s.detail; delete s.fingerprint }
        if (state !== 'down') delete s.nextRetry
        this.sites[name] = s
        return s
    }

    // drop sites no longer in hamon.yml
    retain(names) {
        for (const n of Object.keys(this.sites)) {
            if (!names.includes(n)) delete this.sites[n]
        }
    }

    // a blocked site whose config hasn't changed since it was blocked stays
    // blocked across a restart
    stillBlocked(name, fp) {
        const s = this.sites[name]
        return s != null && s.state === 'blocked' && s.fingerprint === fp
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

module.exports = { SiteState, fingerprint, CHANGE_FIELDS }
