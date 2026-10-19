/*
 * File: service.js - manage the worker threads for locations
 *
 *
 *
 */
const fs = require('fs')
const net = require('net')
const EventEmitter = require('events')
const { Worker } = require('worker_threads')
const yaml = require('js-yaml')
const logger = require('./logger')
const effectiveStack = require('./knxstack').effective
const { SiteState, fingerprint, needsPrecheck, CHANGE_FIELDS, HELD } = require('./sitestate')
const effectiveDedupe = require('./dedupe').effective
const { mappingSignature } = require('./strtodpt')

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
// 'message', 'error' and 'exit' events, and postMessage({ exit: true })
class InlineWorker extends EventEmitter {
    constructor(loc, data) {
        super()
        const { createSite } = require('./site')
        const name = loc.name
        this.site = createSite(loc, data, {
            connected: () => this.emit('message', { connected: name }),
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
const everConnected = new Set() // sites that have connected since hamon started
const pending = {} // back-off timers, by name
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
    if (siteState == null) return
    siteState.set(name, state, { failures: failures[name] || 0, ...extra })
    saveState()
}

function backoffDelay(count) {
    if (count <= RESTART_FREE) return 0;
    return Math.min(BACKOFF_BASE * 2 ** (count - RESTART_FREE - 1), BACKOFF_MAX);
}

// cancel a pending back-off restart (config change, kpipe restart)
function cancelPending(name) {
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
                   stack: effectiveStack(loc.stack, stack), // site's, else top-level, else knx
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
      requestRestart(loc.name);
    })
    worker.on('message', (data) => {
       if (data && data.connected) { // KNX link up - clear the back-off
           failures[data.connected] = 0;
           everConnected.add(data.connected);
           delete lastBlocked[data.connected];
           setState(data.connected, 'connected');
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
    const delay = backoffDelay(failures[name]);
    if (delay == 0) {
        restart(name);
        return;
    }
    logger.info(`Back-off: ${name} restart ${failures[name]} in ${delay / 60000}min`)
    scheduleRestart(name, delay);
}

// restart a site after its back-off wait
function scheduleRestart(name, delay) {
    cancelPending(name);
    setState(name, 'down', { nextRetry: new Date(Date.now() + delay).toISOString() });
    pending[name] = setTimeout(() => {
        delete pending[name];
        // the config may have changed while waiting
        const loc = findLoc(name, originalDoc);
        if (loc != null && loc["enabled"] == true) {
            restart(name);
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
        pipe.on('data', (data) => { // process data ...
            let ksite = data.toString();
            if (ksite.length > 1) {
                ksite = ksite.slice(0, -1); // remove the NL
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
        });
    });

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
    siteState = new SiteState(path + 'tmp/site-state.json');
    if (!siteState.load()) logger.info(`No site state from the last run - starting every enabled site`)
    originalDoc = getDoc(hamonConfig); // note so it availabe
    return ConnectionService(true, path, originalDoc);
     // getDoc(hamonConfig))
  }
}

module.exports.runService = runService
