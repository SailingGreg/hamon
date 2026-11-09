/*
 * File: service.js - manage the worker threads for locations
 *
 *
 *
 */
const fs = require('fs')
const net = require('net')
const dnsp = require('dns').promises
const EventEmitter = require('events')
const { Worker } = require('worker_threads')
const yaml = require('js-yaml')
const logger = require('./logger')
const effectiveStack = require('./knxstack').effective
const { SiteState, fingerprint, needsPrecheck, CHANGE_FIELDS, HELD } = require('./sitestate')
const effectiveDedupe = require('./dedupe').effective
const { mappingSignature } = require('./strtodpt')
const { execFile } = require('child_process')
const { Silence, loadThresholds, cooldown, mode: silenceMode } = require('./silence')
const { uplinkDown } = require('./uplink')

// sites run one per worker thread (the default), or all in this thread with
// the top-level `threads: false` in hamon.yml. A feature flag that can be
// backed out live: when it changes, the next hamon.yml reload stops every
// site and starts it again in the other mode (no ha-mon restart)
let useThreads = true

// in one thread, a library error thrown from a socket callback can't be tied
// to a site: log it and carry on rather than take every site down
function uncaught(err) {
    logger.error(`Uncaught exception (main thread): ${err && err.stack || err}`)
}

// apply the threads flag from hamon.yml; true if the mode changed
function setThreads(doc) {
    const want = doc.threads !== false
    require('./dbv2').setSurvey(doc.survey === true) // used by sites in this thread
    if (want === useThreads) return false
    useThreads = want
    if (useThreads) {
        process.removeListener('uncaughtException', uncaught)
        logger.info('threads: one worker thread per site')
    } else {
        process.on('uncaughtException', uncaught)
        logger.info('threads: false - every site runs in the main thread')
    }
    return true
}

// a site in this thread, looking like a Worker to the rest of this file:
// 'message', 'error' and 'exit' events, and postMessage({ exit: true } or { check: true })
class InlineWorker extends EventEmitter {
    constructor(loc, data) {
        super()
        const { createSite } = require('./site')
        const name = loc.name
        this.site = createSite(loc, data, {
            connected: () => this.emit('message', { connected: name }),
            gateway: (tunnelVersion) => this.emit('message', { gateway: name, tunnelVersion }),
            alive: (lastData) => this.emit('message', { alive: name, lastData }),
            stopped: (reason, detail) => { this.emit('message', { stopped: name, reason, detail }); this.done() },
            timeout: () => { this.emit('message', name); this.done() },
            error: (err) => { this.emit('error', err); this.done() },
        })
        setImmediate(() => this.site.start().catch((err) => {
            this.emit('error', err)
            this.done()
        }))
    }
    postMessage(msg) {
        if (msg && msg.exit) this.site.stop().then(() => this.done())
        else if (msg && msg.check) this.site.check()
    }
    done() {
        if (this.exited) return
        this.exited = true
        setImmediate(() => this.emit('exit', 0))
    }
}
//const dnsSync = require('dns-sync')

let firstRun = true
//var dnsEntry = ''
const threads = new Set()

// restart back-off for sites that stay down: the first RESTART_FREE restarts
// are immediate, then the delay doubles from BACKOFF_BASE up to BACKOFF_MAX.
// The count resets when the worker reports a successful KNX connection.
const RESTART_FREE = 3
const BACKOFF_BASE = 15 * 60 * 1000 // 15min
const BACKOFF_MAX = 4 * 60 * 60 * 1000 // 4h
const failures = {} // consecutive restarts without a connection, by name
// worker errors by name, and when the last was: a connection doesn't clear
// them (a site that errors right after connecting would otherwise restart
// with no delay, again and again), only CRASH_QUIET without one or a change
// to its hamon.yml entry
const CRASH_QUIET = 10 * 60 * 1000 // 10min
const crashes = {}
const crashAt = {}
const everConnected = new Set() // sites that have connected since hamon started
const pending = {} // back-off timers, by name
// while a site waits out a back-off, its DNS name is looked up every
// DNS_RECHECK: a new address (a site's broadband IP changed, its dynamic DNS
// caught up) restarts it at once rather than after up to BACKOFF_MAX
const DNS_RECHECK = 5 * 60 * 1000 // 5min
const dnsWatch = {} // stop functions for those lookups, by name
const lastBlocked = {} // why a site was last blocked, until it connects or its config changes

// each site's state, kept in tmp/site-state.json (see sitestate.js); set up in
// runService. Saves are batched so a start of 40 sites writes the file once
let siteState = null
let saveTimer = null
let saveFailed = false
function saveState() {
    if (siteState == null || saveTimer != null) return
    saveTimer = setTimeout(() => {
        saveTimer = null
        reportSave(siteState.save())
    }, 500)
}
function reportSave(err) {
    if (err != null && !saveFailed) logger.error(`Site state not saved: ${err}`) // once, not every change
    saveFailed = err != null
}
function setState(name, state, extra = {}) {
    // a held or disabled site isn't silent, it's stopped: its spell ends
    if (silence != null && (state === 'disabled' || HELD.includes(state))) { silence.forget(name); delete lastSeen[name] }
    if (siteState == null) return
    siteState.set(name, state, { failures: failures[name] || 0, ...extra })
    saveState()
}

// a worker error: count it, and raise the restart count to it so the
// restart backs off on repeated errors even though the site connected in between
function noteCrash(name, now) {
    if (now - (crashAt[name] || 0) > CRASH_QUIET) crashes[name] = 0
    crashes[name] = (crashes[name] || 0) + 1
    crashAt[name] = now
    failures[name] = Math.max(failures[name] || 0, crashes[name] - 1)
}

function backoffDelay(count) {
    if (count <= RESTART_FREE) return 0;
    return Math.min(BACKOFF_BASE * 2 ** (count - RESTART_FREE - 1), BACKOFF_MAX);
}

// look up host every `every` ms and call onChange(was, now) once when the
// address differs from the first lookup (a first lookup that fails counts as
// no address, so a name that starts resolving is a change too). Returns a
// function that stops it.
function watchDns(host, every, onChange, lookup = (h) => dnsp.lookup(h, { family: 4 })) {
    let stopped = false
    let was
    const look = () => lookup(host).then((r) => r.address, () => null)
    look().then((a) => { was = a })
    const timer = setInterval(() => {
        look().then((now) => {
            if (stopped || was === undefined || now == null || now === was) return
            stop()
            onChange(was, now)
        })
    }, every)
    const stop = () => { stopped = true; clearInterval(timer) }
    return stop
}

// cancel a pending back-off restart (config change, kpipe restart)
function cancelPending(name) {
    if (dnsWatch[name] != null) {
        dnsWatch[name]();
        delete dnsWatch[name];
    }
    if (pending[name] != null) {
        clearTimeout(pending[name]);
        delete pending[name];
        logger.info(`Back-off cancelled: ${name}`)
    }
}

// need to add try/except
const getDoc = (hamonConfig) => yaml.load(fs.readFileSync(hamonConfig, 'utf8'));

let sigcnt = 0;
let shuttingDown = false; // a signal arrived: exit once the last site has stopped
// deal with signals and exit gracefully
function sigHandler(signal) {
    let ttype = typeof signal;
    console.log(`Caught interrupt ${signal} ${ttype}`);

    // following is basically redundant with the addition of setTimeout()
    sigcnt++;
    if (sigcnt > 1) // use this to ensure abort
        process.exit(1);

    // the state file says ha-mon has stopped (the site states are kept for the next start)
    if (siteState != null) {
        clearTimeout(saveTimer);
        saveTimer = null;
        reportSave(siteState.save(false));
    }

    // signal threads to exit
    for (let worker of threads) {
        //console.log("exiting threads");
        worker.postMessage({ exit: true });
    }

    // wait for the sites to stop: exit as soon as the last one has (see the
    // 'exit' handler in startWorker), or after the timeout if one doesn't
    if (threads.size > 0) {
        shuttingDown = true
        let timeout = 450 * threads.size; // 450msec per site
        console.log(`${useThreads ? 'Threads' : 'Sites'} outstanding ${threads.size}, setting timeout`)
        setTimeout (() => {
            console.log(`Timeout and exiting`)
            process.exit()
        }, timeout);
    } else {
        console.log(`Exiting`)
        process.exit();
    }
}

// handle CTRL-C, SIGTERM and SIGHUP from systemd
process.on('SIGINT', sigHandler);
process.on('SIGTERM', sigHandler);
process.on('SIGHUP', sigHandler);

//let orgLoc = {};
//let orgDoc = {};
let originalDoc = {};
let orgPath = "";

// the hamon.yml locations last applied, for siblingsOf
let currentLocs = {}

// other enabled sites on the same gateway (one bus, two ETS projects): a site
// doesn't report their GAs as unmapped
function siblingsOf(loc) {
    const port = (l) => String(l.port || 3671)
    return Object.values(currentLocs)
        .filter((o) => o && o.name !== loc.name && o.enabled !== false && o.config
                && String(o.dns) === String(loc.dns) && port(o) === port(loc))
        .map((o) => ({ name: o.name, config: o.config }))
}

function start_worker(path, influxver, loc, survey, stack, dedupe) {

    loc["path"] = path; // add path
    loc["influxver"] = influxver; // add influxdb version

    /*
    // if still link then ensure it is terminated!
    if (loc["worker"] != null) {
        loc["worker"].postMessage({ exit: true });
    }
    */
    loc["worker"]=""; // delete the worker so the structure can be cloned

    // a site that hasn't connected since hamon started gives up after a few
    // minutes and goes into the restart back-off (see connection.js); one
    // that hasn't connected for days first checks its gateway answers
    const data = { location: loc, connectedBefore: everConnected.has(loc.name),
                   precheck: needsPrecheck(siteState != null ? siteState.get(loc.name) : null),
                   failures: failures[loc.name] || 0,
                   survey: survey === true, // top-level `survey: true` in hamon.yml
                   stack: effectiveStack(loc.stack, stack), // top-level, else site's, else knx
                   dedupe: effectiveDedupe(loc.dedupe, dedupe), // ms: site's, else top-level, else 0 (off)
                   siblings: siblingsOf(loc) }
    const worker = useThreads ? new Worker(path + './src/connection.js', { workerData: data })
                              : new InlineWorker({ ...loc }, data)
    threads.add(worker)
    setState(loc.name, 'starting')

    // an uncaught error (e.g. knx rejecting a reserved address) ends this
    // worker - restart just this site rather than taking down hamon
    worker.on('error', (err) => {
      logger.error(`Worker error: ${loc.name} - ${err}`)
      noteCrash(loc.name, Date.now())
      requestRestart(loc.name);
    })
    worker.on('message', (data) => {
       if (data && data.connected) { // KNX link up - clear the back-off
           downConnected(data.connected);
           failures[data.connected] = 0;
           everConnected.add(data.connected);
           delete lastBlocked[data.connected];
           setState(data.connected, 'connected');
       } else if (data && data.alive) { // a minute report while connected
           alive(data.alive, data.lastData);
       } else if (data && data.gateway) { // what the gateway offers, for hamon-upload
           if (siteState != null) { siteState.note(data.gateway, { tunnelVersion: data.tunnelVersion }); saveState(); }
       } else if (data && data.stopped) { // the worker stopped and says why
           stopped(data);
       } else {
           requestRestart(data); // worker timed out - pass location
       }
    });
    worker.on('exit', () => {
      threads.delete(worker)
      // a pending timer means this site is waiting out its restart back-off
      const st = siteState != null ? siteState.get(loc.name) : null
      const why = pending[loc.name] ? ` (back-off, restart ${failures[loc.name]}`
            + ` in ${backoffDelay(failures[loc.name]) / 60000}min)`
            : (st != null && HELD.includes(st.state)) ? ` (${st.state}, ${st.reason})` : ''
      // 'Thread' for a worker, 'Site' for one in the main thread (threads: false)
      console.log(`${worker instanceof InlineWorker ? 'Site' : 'Thread'} exiting: ${loc.name}${why}, ${threads.size} running...`)
      if (shuttingDown && threads.size === 0) {
        console.log(`Exiting`)
        process.exit()
      }
    })

    return (worker);
}

// find the location - returns null if 'new'
function findLoc (name, oDoc) {
    for (location in oDoc.locations) {
        const loc = oDoc.locations[location]
        if (loc.name == name )
            return (loc);
    }
    return null;
}

// compare locations - the stacks given are the old and new top-level defaults
function compareLoc(oldLoc, newLoc, oldStack, newStack) {
    let change = false;

    // do a field by field comparison - but name excluded! (the fields are
    // shared with sitestate.js, which ties a block to them)
    for (const f of CHANGE_FIELDS) {
        if (oldLoc[f] != newLoc[f]) change = true;
    }
    // the stack the site runs on, so a top-level change only restarts the sites it moves
    if (effectiveStack(oldLoc['stack'], oldStack) != effectiveStack(newLoc['stack'], newStack)) change = true;

    return change; // return flag
}

// worker asked to be restarted - apply back-off if it keeps failing
function requestRestart(name) {
    failures[name] = (failures[name] || 0) + 1;
    if (failures[name] === 1 && containerMode(name) !== 'off') downSince[name] = Date.now();
    let delay = backoffDelay(failures[name]);
    if (delay == 0) {
        restartSite(name);
        return;
    }
    // a container site going into back-off: its container is restarted now
    if (failures[name] === RESTART_FREE + 1 && downRetry(name)) return;
    // ... and its later retries run a step behind (15, 30 ... 240 min after it)
    if (failures[name] > RESTART_FREE + 1 && containerMode(name) === 'act') delay = backoffDelay(failures[name] - 1);
    logger.info(`Back-off: ${name} restart ${failures[name]} in ${delay / 60000}min`)
    scheduleRestart(name, delay);
}

// restart a site after its back-off wait
function scheduleRestart(name, delay) {
    cancelPending(name);
    setState(name, 'down', { nextRetry: new Date(Date.now() + delay).toISOString() });
    const loc = Object.values(currentLocs).find((l) => l && l.name === name); // as being applied
    const host = loc != null && loc.dns != null ? String(loc.dns) : '';
    if (delay > DNS_RECHECK && host !== '' && !net.isIP(host)) {
        dnsWatch[name] = watchDns(host, DNS_RECHECK, (was, now) => {
            delete dnsWatch[name];
            if (pending[name] == null) return // restarted meanwhile
            logger.info(`Back-off: ${name} ${host} now ${now} (was ${was || 'unresolved'}) - restarting now`)
            cancelPending(name);
            failures[name] = 0; // a new address: the normal immediate retries again
            restart(name);
        });
    }
    pending[name] = setTimeout(() => {
        delete pending[name];
        if (dnsWatch[name] != null) { dnsWatch[name](); delete dnsWatch[name]; }
        // the config may have changed while waiting
        const loc = findLoc(name, originalDoc);
        if (loc != null && loc["enabled"] == true) {
            if (!downRetry(name)) restartSite(name); // a container site: its container first
        } else {
            logger.info(`Back-off: ${name} no longer enabled, not restarting`)
            setState(name, 'disabled');
        }
    }, delay);
}

// a worker stopped and said why, and it's one a retry won't fix - so no timed
// retry; a change to the site's own hamon.yml entry (or its GA file) or kpipe
// re-checks it:
//   blocked        its DNS name doesn't resolve, or its gateway doesn't answer
//   misconfigured  its config is incomplete or wrong (Secure values, GA file)
const HOLD_REASONS = { dns: 'blocked', unreachable: 'blocked', config: 'misconfigured' }
function stopped(data) {
    const name = data.stopped;
    const state = HOLD_REASONS[data.reason];
    if (state == null) { // not one we hold a site for: as a timeout
        logger.info(`${name}: stopped (${data.reason}) - ${data.detail}`)
        requestRestart(name);
        return;
    }
    cancelPending(name);
    const loc = findLoc(name, originalDoc);
    const fp = loc != null ? fingerprint(loc, effectiveStack(loc.stack, originalDoc.stack), loc.mtime) : null;
    // a kpipe re-check that fails the same way stays out of error.log
    if (lastBlocked[name] === data.reason) {
        logger.info(`${name}: still ${state} (${data.reason}) - ${data.detail}`)
    } else {
        logger.error(`${name}: ${state.toUpperCase()} (${data.reason}) - ${data.detail}; `
                     + `re-checked when its hamon.yml entry changes or on kpipe`)
    }
    lastBlocked[name] = data.reason;
    setState(name, state, { reason: data.reason, detail: data.detail, fingerprint: fp });
}

// start/restart the location
function restart (name) {
    console.log(`Restart: ${name}`);
    let loc = [];

    // find the location - user loc = findLoc(name originalDoc);
    for (location in originalDoc.locations) {
        loc = originalDoc.locations[location]
        if (loc.name == name )
            break;
    }
    //loc = orgLoc;
    logger.info(`Restarting: ${loc.name} - ${name}`)

    // and start it
    let wrk = start_worker(orgPath, originalDoc.influxdb, loc, originalDoc.survey, originalDoc.stack, originalDoc.dedupe);
    loc["worker"] = wrk; // and recorded the 'worker'

}


// called with current doc for config file
async function ConnectionService(firstrun, path, doc) {
  currentLocs = doc.locations || {}
  // note for restart
  //orgDoc = doc;

  orgPath = path;
  let wrk = "";

  /*
  // exit existing workers
  for (let worker of threads) {
    // allow the thread to exit
    worker.postMessage({ exit: true });
    //worker.terminate()
  }
  // really need a timeout/wait to ensure all threads exit
  // that is threads.size reaches 0
  threads.clear()
  */
  // iterate over the 'existing' config and see if new or changed
  //console.log(doc.influxdb)
  // threads flag changed: every running site restarts in the new mode (a
  // blocked site, or one waiting out its back-off, uses it at its next start)
  const modeChanged = firstrun != true && setThreads(doc)
  if (modeChanged) logger.info('threads changed - restarting the running sites in the new mode')

  for (location in doc.locations) {
    let loc = doc.locations[location]
    logger.info(`Checking: ${loc.name} ${loc.dns} ${loc.port} ${loc.device}`)

    // added config to suport move of config files. A missing GA file has no
    // mtime; the site's worker reports it (misconfigured)
    let stats = { mtimeMs: null };
    try { stats = fs.statSync(path + 'config/' + loc.config); } catch (e) { }
    //let stats = fs.statSync(path + loc.config);
    if (firstrun != true) { // check if there is a change
        // config change?
        let oldLoc = findLoc(loc.name, originalDoc);

        if (oldLoc != null) {

            // if config change or mtime for config file
            const configChanged = compareLoc(oldLoc, loc, originalDoc.stack, doc.stack) ||
                    (stats.mtimeMs != oldLoc['mtime'])
            const running = threads.has(oldLoc["worker"])
            // like the threads flag, a dedupe change only restarts a running
            // site: a blocked site isn't re-checked, one in back-off waits on
            const dedupeChanged = effectiveDedupe(oldLoc.dedupe, originalDoc.dedupe)
                    != effectiveDedupe(loc.dedupe, doc.dedupe)
            // and so does a change to the dptmappings lines it uses
            const mappingChanged = oldLoc.mapsig !== undefined
                    && oldLoc.mapsig != mappingSignature(path, loc.name)
            if (configChanged || ((modeChanged || dedupeChanged || mappingChanged) && running)) {
                // restart so terminate and start
                let diff = stats.mtimeMs - oldLoc["mtime"];
                logger.info(configChanged ? `Change so restarting: ${loc.name} ${diff}`
                            : modeChanged ? `Restarting in the new threads mode: ${loc.name}`
                            : dedupeChanged ? `Restarting with dedupe ${effectiveDedupe(loc.dedupe, doc.dedupe) / 1000}s: ${loc.name}`
                            : `Restarting with changed dptmappings: ${loc.name}`)
                if (configChanged) {
                    cancelPending(loc.name);
                    failures[loc.name] = 0;
                    crashes[loc.name] = 0;
                    delete lastBlocked[loc.name];
                }

                //terminate and restart
                // we don't need to delete as it is done on exit
                wrk = oldLoc["worker"];
                if (running) {
                    logger.info("Existing worker terminating");
                    wrk.postMessage({ exit: true });
                } else {
                    // blocked, or waiting out its back-off: nothing to stop
                    logger.info(`No running worker for: ${loc.name}`);
                }

                if (loc["enabled"] == true) { // restart
                    wrk = start_worker(path, doc.influxdb, loc, doc.survey, doc.stack, doc.dedupe);
                    loc["worker"] = wrk;
                    //doc.locations[location]["worker"] = wrk;
                } else {
                    logger.info(`Not restarting: ${loc.name}`)
                    setState(loc.name, 'disabled');
                }

            } else { // do nothing
                logger.info(`No change for: ${loc.name}`);
                // ensure the 'worker' is noted - we address mtime below
                loc["worker"] = oldLoc["worker"];
            }
 
        } else { // new entry in config file
            //start it
            if (loc["enabled"] == true) { // only if enabled
                logger.info(`New entry for: ${loc.name}`)
                wrk = start_worker(path, doc.influxdb, loc, doc.survey, doc.stack, doc.dedupe);
                loc["worker"] = wrk;
                //doc.locations[location]["worker"] = wrk;
            } else {
                setState(loc.name, 'disabled');
            }
        }

    } else { // first run so just start it
        //console.log(loc);
        if (loc["enabled"] == true) { // only if enabled
            logger.info(`First run for: ${loc.name}`)
            // carry on from the last run (tmp/site-state.json): a blocked site
            // whose config hasn't changed stays blocked, a site in back-off
            // keeps its count and waits out what's left of its delay - unless
            // it is due a gateway check (no connection in 7 days): that takes
            // seconds, not a 5-minute worker, so it is checked now and a site
            // that isn't online is blocked at start
            const last = siteState != null ? siteState.get(loc.name) : null;
            const fp = fingerprint(loc, effectiveStack(loc.stack, doc.stack), stats.mtimeMs);
            if (last != null && last.state !== 'connected') {
                failures[loc.name] = last.failures || 0;
            }
            if (siteState != null && siteState.stillBlocked(loc.name, fp)) {
                lastBlocked[loc.name] = last.reason;
                logger.info(`${loc.name}: still ${last.state} (${last.reason}) since ${last.since} - not started; `
                            + `change its hamon.yml entry or kpipe it to re-check`)
            } else if (last != null && last.state === 'down' && last.nextRetry != null
                       && Date.parse(last.nextRetry) > Date.now() && !needsPrecheck(last)) {
                const delay = Date.parse(last.nextRetry) - Date.now();
                logger.info(`Back-off resumed: ${loc.name} restart ${failures[loc.name]} in ${Math.round(delay / 60000)}min`)
                scheduleRestart(loc.name, delay);
            } else {
                // start worker
                wrk = start_worker(path, doc.influxdb, loc, doc.survey, doc.stack, doc.dedupe);
                loc["worker"] = wrk;
                //doc.locations[location]["worker"] = wrk;
            }
        } else {
            setState(loc.name, 'disabled');
        }
    }

    // note the current config file stamp, and the dptmappings lines it uses
    loc["mtime"] = stats.mtimeMs;
    loc["mapsig"] = mappingSignature(path, loc.name);
    //console.log("Loc ", loc);
  }
  // sites taken out of hamon.yml drop out of the state file
  if (siteState != null) {
    siteState.retain(Object.values(doc.locations || {}).map(l => l.name));
    saveState();
  }
}
// ---- silence: connected but sending nothing (silence.js) ---------------------
// set up in runService; the top-level `silence:` key in hamon.yml says
// whether it only logs (report) or restarts (act)
let silence = null
let reinitSite = null // the kpipe restart, set up in runService
const lastSeen = {}   // name -> the last telegram (ms), carried over a restart (silenceFrom)
const containerRestarted = {} // container -> when: two sites on one container restart it once

let docker = (args, cb) => execFile('docker', args, cb) // replaced in tests
let CONTAINER_UP = 10 * 1000 // after a container restart, for its VPN to come up

// a site's dns, '' if none: a container site's is its container's IP (172.*)
function siteDns(name) {
    const loc = findLoc(name, originalDoc)
    return loc != null && loc.dns != null ? String(loc.dns) : ''
}

// the running container on the hamon network with this IP ('' if none)
function containerFor(ip, cb) {
    docker(['ps', '-q'], (err, out) => {
        const ids = err ? [] : out.split(/\s+/).filter(Boolean)
        if (ids.length === 0) return cb('')
        docker(['inspect', '-f', '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', ...ids], (err2, info) => {
            const row = err2 ? null : info.split('\n').map((l) => l.trim().split(/\s+/)).find((f) => f.slice(1).includes(ip))
            cb(row ? row[0].replace(/^\//, '') : '')
        })
    })
}

// restart the container holding ip, at most once a minute (sites can share
// one); report mode only says what it would do. done(how, wait): wait is true
// when the container has just been (or is being) restarted
function restartContainer(ip, act, done) {
    containerFor(ip, (cont) => {
        if (cont === '') return done(`no container at ${ip}`, false)
        if (Date.now() - (containerRestarted[cont] || 0) < 60 * 1000) return done(`container ${cont} restarted already`, act)
        containerRestarted[cont] = Date.now()
        if (!act) return done(`docker restart ${cont}`, false)
        docker(['restart', cont], (err) => {
            done(err ? `docker restart ${cont} FAILED (${err.message.trim()})` : `docker restart ${cont}`, !err)
        })
    })
}

// what a silence restart does: a container site (dns 172.*) gets its
// container restarted first, then every site is re-initialised as by kpipe
function silenceRestart(name, act, done) {
    const dns = siteDns(name)
    const reinit = () => { if (act && reinitSite != null) reinitSite(name) }
    if (!dns.startsWith('172.')) { done('re-init'); return reinit() }
    restartContainer(dns, act, (how) => {
        const did = /^docker restart \S+$/.test(how) // restarted, or would have in report mode
        done(did ? `${how} + re-init` : `${how} - re-init only`)
        setTimeout(reinit, did && act ? CONTAINER_UP : 0) // let the VPN come up first
    })
}

// ---- container sites that stay down (step 3 of docs/site-states.md) ---------
// a container site (dns 172.*) whose link keeps failing has its container
// restarted as it goes into the back-off - a lost VPN path only comes back
// that way - and again at each back-off retry, which for these sites runs a
// step behind (15, 30 ... 240 min). Not while the uplink is down, at most
// max_restarts until the site connects, and only logged in `silence: report`
const downRestarts = {} // name -> container restarts since it last connected
const downSince = {}    // name -> its first failure since it last connected (ms)
const downCapped = new Set() // sites that reached max_restarts (logged once)
let restartSite = (name) => restart(name) // replaced in tests

// 'off' | 'report' | 'act' for a container site, 'off' for any other
function containerMode(name) {
    if (silence == null || !siteDns(name).startsWith('172.')) return 'off'
    return silenceMode(originalDoc)
}

// a back-off retry for a site: a container site restarts its container, then
// the site once the VPN is up. True when that's under way (act mode), false
// when the caller restarts the site as before
function downRetry(name) {
    const m = containerMode(name)
    if (m === 'off') return false
    const act = m === 'act'
    const say = (how, warn = true) => {
        const line = `Back-off: ${name} down, ${how}${act ? '' : ' (report only)'}`
        console.log(line)
        if (warn) logger.warn(line); else logger.info(line)
    }
    const t = silence.thresholds()
    const max = t != null ? t.maxRestarts : 6
    const n = downRestarts[name] || 0
    if (max > 0 && n >= max) {
        if (!downCapped.has(name)) { downCapped.add(name); say(`${max} container restarts haven't helped - plain retries until it connects`) }
        return false
    }
    const up = silence.uplink()
    if (up != null) { say(`container restart held - uplink down (${up})`, false); return false }
    downRestarts[name] = n + 1
    restartContainer(siteDns(name), act, (how, wait) => {
        say(`container restart ${n + 1}: ${how}`)
        if (act) setTimeout(() => restartSite(name), wait ? CONTAINER_UP : 0)
    })
    return act
}

// a site connected: how long a container site was down, and whether its
// container restarts went with it
function downConnected(name) {
    if (downSince[name] != null && (failures[name] || 0) > RESTART_FREE) {
        const mins = Math.round((Date.now() - downSince[name]) / 60000)
        const line = `Back-off: ${name} connected again after ${mins}m down, ${downRestarts[name] || 0} container restart(s)`
            + (containerMode(name) === 'report' ? ' (report only)' : '')
        console.log(line)
        logger.info(line)
    }
    delete downSince[name]
    delete downRestarts[name]
    downCapped.delete(name)
}

// where a site's silence clock starts when this run first hears from it: its
// last telegram on record, or for a site silent since before the last run
// started, when that spell's threshold was reached less the threshold. The
// time ha-mon was stopped doesn't count, so a quick restart neither resets
// the clock nor makes a long stop look like silence. Its spell (restarts so
// far) is carried over too
const carried = new Set() // sites whose silence has been carried over this run
function silenceFrom(name) {
    const st = siteState != null ? siteState.get(name) : null
    if (carried.has(name)) return Date.now() // re-enabled or unblocked: start afresh
    carried.add(name)
    const down = siteState != null ? siteState.downtime : 0
    if (st != null && silence != null) silence.restore(name, st.silent, down)
    let from = st != null && st.lastData ? Date.parse(st.lastData) : NaN
    if (isNaN(from) && st != null && st.silent != null) {
        const t = silence != null ? silence.thresholds() : null
        const thresh = t == null ? 0 : (t.sites[name] != null ? t.sites[name] : t.default)
        from = Date.parse(st.silent.since) - thresh * 60000
    }
    return isNaN(from) ? Date.now() : Math.min(from + down, Date.now())
}

// a worker's minute report: the site's last telegram
function alive(name, lastData) {
    let prev = lastSeen[name] // the telegram before this report's: the gap if data is back
    if (lastSeen[name] == null) {
        const from = silenceFrom(name) // carries the spell over too
        prev = from
        lastSeen[name] = lastData != null ? lastData : from // a telegram this run is newer
    }
    if (lastData != null && !(lastSeen[name] >= lastData)) lastSeen[name] = lastData
    const iso = (ms) => new Date(ms).toISOString()
    if (siteState != null && lastData != null) { siteState.note(name, { lastData: iso(lastSeen[name]) }); saveState() }
    const m = silenceMode(originalDoc)
    if (m === 'off' || silence == null) return
    const st = siteState != null ? siteState.get(name) : null
    const first = st != null && st.firstConnected ? Date.parse(st.firstConnected) : null
    const r = silence.check(name, lastSeen[name], first)
    const tag = m === 'report' ? ' (report only)' : ''
    if (r.do === 'restart') {
        silenceRestart(name, m === 'act', (how) => {
            const line = `Silent: ${name} no data for ${r.age}m (>= ${r.thresh}m), restart ${r.n}: ${how}${tag}`
            console.log(line)
            logger.warn(line)
        })
    } else if (r.do === 'hold' && r.first) {
        const line = `Silent: ${name} no data for ${r.age}m (>= ${r.thresh}m), held - uplink down (${r.why})${tag}`
        console.log(line)
        logger.warn(line)
    } else if (r.do === 'grace' && r.first) {
        const line = `Silent: ${name} no data for ${r.age}m (>= ${r.thresh}m), new site - not restarted until ${iso(r.until)}${tag}`
        console.log(line)
        logger.warn(line)
    } else if (r.do === 'stop') {
        const line = `Silent: ${name} no data for ${r.age}m (>= ${r.thresh}m), ${r.n} restarts haven't helped - no more until data (bus quiet or dead at the site?)${tag}`
        console.log(line)
        logger.warn(line)
    } else if (r.do === 'end') {
        // the real gap in the data, then how long the site had been counted silent
        const gap = lastData != null && prev != null ? `after a ${Math.round((lastData - prev) / 60000)}m gap ` : ''
        const line = `Silent: ${name} data again ${gap}(${r.minutes}m past the threshold), ${r.restarts} restart(s)${tag}`
        console.log(line)
        logger.info(line)
    }
    // in the site's state for hamon-upload: { since, restarts, next, held, stopped }
    const s = siteState != null ? siteState.get(name) : null
    if (s == null) return
    const sp = silence.spells[name]
    const t = silence.thresholds()
    let silent
    if (sp != null) silent = { since: iso(sp.since), restarts: sp.n, next: t != null ? iso(sp.t + cooldown(t, sp.n) * 60000) : null }
    if (sp != null && sp.stopped) silent = { since: iso(sp.since), restarts: sp.n, stopped: true }
    if (r.do === 'hold') silent = { ...(silent || { since: iso(r.since), restarts: 0 }), held: 'uplink' }
    if (r.do === 'grace') silent = { since: iso(r.since), restarts: 0, grace: iso(r.until) }
    if (silent !== undefined || s.silent !== undefined) { siteState.note(name, { silent }); saveState() }
}

let last_time = 0;
let d = new Date().getTime();

// main entry
async function runService(path, hamonConfig) {

    // setup the named pipe listener
    var pname = path + '/tmp/kpipe' // the fifo 

    // we open it read/write so the pipe doesn't get closed on EOF
    fs.open(pname, fs.constants.O_RDWR | fs.constants.O_NONBLOCK, (err, fd) => {
        // Handle err
        if (err != null) {
            console.log("Error opening named pipe");
            logger.error(`Error open named pipe ${pname}`);
            process.exit(1);
        }
        const pipe = new net.Socket({ fd });
        // Now `pipe` is a stream that can be used for reading from the FIFO.
        // one command per line: "<site>" restarts it, "check <site>" asks the
        // site to check its tunnel now (utils/vpn-reconnect.sh)
        pipe.on('data', (data) => {
            for (const line of data.toString().split('\n')) kpipeCommand(line.trim());
        });
    });

    function kpipeCommand(ksite) {
        if (ksite.length < 1) return;
        const check = /^check\s+(\S+)$/.exec(ksite);
        if (check) {
            const loc = findLoc(check[1], originalDoc);
            const wrk = loc != null ? loc["worker"] : null;
            if (wrk != null && wrk !== "") {
                logger.info(`Check requested for ${check[1]}`);
                wrk.postMessage({ check: true });
            } else {
                logger.info(`Check: ${check[1]} has no running site`);
            }
            return;
        }
        reinit(ksite);
    }

    // "<site>" on the kpipe, and a silence restart: stop the site's worker and
    // start it again at once
    function reinit(ksite) {
        logger.info(`Looking to restart ${ksite}`);
        // we can call restart(site) but need to terminate first
        let oldLoc = findLoc(ksite, originalDoc);
        if (oldLoc != null && (oldLoc["enabled"] == true)) {
            let wrk = oldLoc["worker"];
            //console.log("wrk is null? ", wrk == null);
            if (wrk != null && wrk !== "") {
                logger.info("Terminating existing worker");
                wrk.postMessage({ exit: true });
            }
            // and now restart - immediately, overriding any back-off
            // wait (the failure count is kept). This is also how a
            // blocked site is re-checked, which may have no worker
            // (blocked at the last start)
            cancelPending(ksite);
            restart(ksite);
        } else {
            logger.info(`Can't find location ${ksite}`);
        }
    }

  // reload so changes available
  function reload() {
      d = new Date().getTime(); // refresh time
      logger.info("Checking .... %d", (d - last_time));
      let newDoc = getDoc(hamonConfig);
      let rs = ConnectionService(false, path, newDoc);
      originalDoc = newDoc;
      last_time = d; // note time
      return rs;
  }

  // at most one reload per RELOAD_GAP: a change inside it (e.g. a second save
  // straight after the first) is applied when the gap ends, not dropped -
  // a save is how a blocked site gets re-checked
  const RELOAD_GAP = 15 * 1000
  let deferred = null
  // dptmappings.txt is watched too: a reload restarts only the running sites
  // whose lines in it changed (their own, or a shared "" rule)
  const changed = (file) => function (curr, prev) {
        if (file != 'hamon.yml') {   // hamon.yml: any change reloads, as before
            if (curr.mtimeMs == prev.mtimeMs) return
            logger.info(`${file} changed`)
        }
        d = new Date().getTime(); // refresh time
        logger.info("runTime %d -> %d", d, last_time);
        if (d > (last_time + RELOAD_GAP)) {
            return reload();
        }
        if (deferred == null) {
            const wait = last_time + RELOAD_GAP - d + 100;
            logger.info(`${file} changed ${d - last_time}ms after the last reload - applying it in ${wait}ms`)
            deferred = setTimeout(() => {
                deferred = null;
                reload();
            }, wait);
        }
  }
  fs.watchFile(hamonConfig, changed('hamon.yml'))
  fs.watchFile(path + 'dptmappings.txt', changed('dptmappings.txt'))

  if (firstRun) {
    firstRun = false
    setThreads(getDoc(hamonConfig))
    reinitSite = reinit
    // the detector's thresholds file and netprobe's log; the uplink is read at
    // most every 30s however many sites report
    let uplinkAt = 0, uplinkWas = null
    silence = new Silence({
        thresholds: () => loadThresholds(path + 'freshness-thresholds.conf'),
        uplink: () => {
            if (Date.now() - uplinkAt > 30 * 1000) { uplinkAt = Date.now(); uplinkWas = uplinkDown(path + 'alerts/netprobe') }
            return uplinkWas
        },
    })
    siteState = new SiteState(path + 'tmp/site-state.json');
    if (!siteState.load()) logger.info(`No site state from the last run - starting every enabled site`)
    originalDoc = getDoc(hamonConfig); // note so it availabe
    return ConnectionService(true, path, originalDoc);
     // getDoc(hamonConfig))
  }
}

module.exports.runService = runService
// for test/crashbackoff.test.js, backoffdns.test.js and silence.test.js
module.exports._test = { noteCrash, backoffDelay, failures, watchDns, alive, lastSeen,
    requestRestart, downConnected, downRestarts, pending, cancelPending,
    setDocker: (fn) => { docker = fn }, setContainerUp: (ms) => { CONTAINER_UP = ms }, setRestartSite: (fn) => { restartSite = fn },
    setSilence: (s, doc, state) => { silence = s; originalDoc = doc; siteState = state } }
