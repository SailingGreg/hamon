/*
 * site.js - one site's KNX connection: DNS, the gateway check, the tunnel, the
 * GA map and datapoints, events to InfluxDB, MQTT writes.
 *
 * All of a site's state lives in the object createSite() returns, so sites can
 * run either one per worker thread (connection.js wraps one Site; the default)
 * or all in hamon's main thread (top-level `threads: false` in hamon.yml, see
 * service.js). The site reports back through hooks rather than messages:
 *
 *   connected()               the tunnel is up (resets the restart back-off)
 *   stopped(reason, detail)   it stopped for a reason a retry won't fix
 *                             ('dns', 'unreachable'): service.js blocks it
 *   timeout()                 it gave up (no connection in time, or still
 *                             failing 15 min after an error): restart with back-off
 *   error(err)                anything unexpected; treated as a crash
 *
 * The site has already stopped (tunnel and MQTT closed, timers cleared) when
 * stopped(), timeout() or error() is called.
 */
const dnsp = require('dns').promises
const fs = require('fs')
const ets = require('../parsexml')
const logger = require('./logger')
const { writeEvents } = require('./db')
const { writeEventsv2 } = require('./dbv2')
const { MQTTconnect, mqdisconnect } = require('./mqwrite')
const { loadmapping, mapstring, mapaddress } = require('./strtodpt')
const { dptInfo } = require('./dptnames')
const { secureOptions } = require('./secrets')
const { describe } = require('./knxdesc')
const { createDedupe } = require('./dedupe')
const knxstack = require('./knxstack')

// a site that has never connected since hamon started (dead, or not there yet)
// would otherwise retry forever inside the KNX stack, logging every few
// seconds; after FIRST_CONNECT_WAIT give up and let service.js restart it with
// back-off (up to 4h). Sites that have connected before keep retrying here.
const FIRST_CONNECT_WAIT = 5 * 60 * 1000 // 5min
// after an error, how long the stack has to reconnect before the site is
// restarted - 8min was not long enough for the network to stabilise
const ERROR_WAIT = 15 * 60 * 1000
// how long stop() waits for the gateway to confirm a DISCONNECT
const STOP_WAIT = 3000

// default subtype for an ETS DPT given as the main type only (see below)
const DEFAULT_SUBTYPE = { DPT1: '.001', DPT3: '.007', DPT5: '.001', DPT7: '.001', DPT8: '.001', DPT9: '.001', DPT18: '.001' }

// knx's dptlib (used by both stacks) logs through log-driver's default logger,
// which is created at 'trace', so every DPT 20/21 decode printed a [debug]
// 'fromBuffer' line whatever the site's logging. It is one object per process,
// so it is set to the most verbose level any site in this thread asks for:
// the levels below that become no-ops
const quietDptlib = (() => {
    let kept = -1
    let originals = null
    return (logging) => {
        const defaultLog = require('log-driver').logger
        const levels = defaultLog.levels
        originals = originals || Object.fromEntries(levels.map((l) => [l, defaultLog[l]]))
        const keep = Math.max(kept, levels.includes(logging) ? levels.indexOf(logging) : levels.indexOf('info'))
        if (keep === kept) return
        kept = keep
        levels.forEach((lvl, i) => { defaultLog[lvl] = i > keep ? () => {} : originals[lvl] })
    }
})()

// return local date/time - this uses ISO structure
function localDate() {
    const date = new Date()
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString()
}
const ctime = () => localDate().replace(/T/, ' ').replace(/\..+/, '')

// location: the hamon.yml entry (plus path, influxver); opts: { stack,
// connectedBefore, failures, survey, precheck, dedupe (ms, 0 = off) }; hooks: see the top
function createSite(location, opts, hooks) {
    const { dns, port, config, name, path, influxver, logging, device, phyAddr, secure } = location
    // everything this site logs goes through its own logger (see logger.js)
    const log = logger.siteLogger(name)
    const siteStack = opts.stack || location.stack
    const knx = knxstack(siteStack)
    // the stack picks the decoder too: knx decodes/encodes with knx.Datapoint,
    // knxultimate with datapoint.js (KNXUltimate's dptlib)
    const decoder = siteStack === 'knxultimate' ? 'knxultimate' : 'knx'
    const Datapoint = decoder === 'knxultimate' ? require('./datapoint').Datapoint : knx.Datapoint
    // once a never-connected site has given up, its restarts keep the stack
    // quiet - otherwise it logs 'connection timed out, retrying...' every few
    // seconds each time
    const quietRetries = opts.connectedBefore !== true && (opts.failures || 0) > 0
    // bind to influx v1 or v2?
    const writeEvent = influxver == 1 ? writeEvents : writeEventsv2
    // `dedupe:` in hamon.yml: a GA's repeats are written at most once per window
    const dedupe = opts.dedupe > 0
        ? createDedupe(opts.dedupe, (time, args) => writeEvent(...args, time))
        : null

    let connection = null      // the KNX connection, once connect() has run
    let mqttClient = null
    let groupAddresses = {}
    let timerHandle = null     // recovery timer, from the first error since 'connected'
    let firstConnectHandle = null
    let inited = false
    let lastErr = Date.now()
    let stopping = null        // the stop() promise, once stopping
    let finished = false       // a hook has been called; nothing more is reported

    // report once, after the site has stopped
    function finish(hook, ...args) {
        if (finished) return
        finished = true
        stop().then(() => hook(...args))
    }

    // guard a handler: anything it throws ends this site, not hamon
    const guard = (fn) => function (...args) {
        try {
            return fn.apply(this, args)
        } catch (err) {
            finish(hooks.error, err)
        }
    }

    function handleTimeout(why) {
        log.info('%s >>> Timer connection timed out: %s%s', ctime(), name, why ? ` (${why})` : '')
        finish(hooks.timeout)
    }

    function loadGroupAddresses() {
        const configFilePath = path + 'config/' + config
        const ext = config.substring(config.lastIndexOf('.'), config.length)
        if (ext === '.knxproj') {
            // config is json no need to parse it - but need to change extn
            const configFile = configFilePath.substring(0, configFilePath.lastIndexOf('.')) + '.json'
            log.info(`Loading json intermediate file: ${configFile}`)
            return JSON.parse(fs.readFileSync(configFile)).reduce((map, obj) => {
                map[obj.address] = obj
                return map
            }, {})
        }
        // load the xml export
        return ets.parsexml(configFilePath) || {}
    }

    // build the datapoints the first time the tunnel comes up
    function initDatapoints() {
        let cnt = 0, udefined = 0, remapped = 0, overridden = 0
        for (const key in groupAddresses) {
            if (!groupAddresses.hasOwnProperty(key)) continue
            const ga = groupAddresses[key]
            // an exact-address rule comes first: it can replace a wrong
            // ETS dpt ('override') and the misleading name that goes with it
            const arule = mapaddress(name, key)
            if (arule !== undefined) {
                if (arule.dpt !== undefined && (arule.override || ga.dpt == undefined)) {
                    if (ga.dpt == undefined) remapped++
                    else overridden++
                    ga.dpt = arule.dpt
                }
                if (arule.name !== undefined) ga.name = arule.name
            }
            // map name string to dtp
            if (ga.dpt == undefined) {
                ga.dpt = mapstring(name, ga.name)
                if (ga.dpt != undefined) remapped++
            }
            // add a default subtype where ETS gave only the main type:
            // without one knx's dptlib gives no type name and the GA is never
            // stored. 3.007 (dimming) is the usual bare DPT3; DPT3 and DPT18
            // decode to objects, so they reach dbv2's composite (DBSKIP) path
            if (DEFAULT_SUBTYPE[ga.dpt] !== undefined) ga.dpt += DEFAULT_SUBTYPE[ga.dpt]
            // construct dp for the group address (still done for undefined DPTs)
            ga.endpoint = new Datapoint({ ga: key, dpt: ga.dpt }, connection)
            // name and unit from hamon's own table, not the KNX library
            const info = dptInfo(ga.dpt)
            ga.unit = info !== undefined ? info.unit : ''
            ga.type = info !== undefined ? info.name : ''
            // set a guard if dpt is not defined for the key
            if (ga.dpt == undefined) {
                ga.type = undefined
                udefined++
            }
            cnt++
        }
        log.info('GA for %s: %j (%d undefined/%d remapped/%d overridden)',
                    name, cnt, udefined, remapped, overridden)
    }

    function onEvent(evt, src, dest, value) {
        if (!groupAddresses.hasOwnProperty(dest)) return
        const ga = groupAddresses[dest]
        // note use of endpoint.current_value gives the 'decoded' value
        log.info('>> %s Event %s %j -> %j (%s - %s) - %j %s %j',
            ctime(), evt, src, dest, ga.name, ga.type, ga.endpoint.current_value, ga.unit,
            typeof (ga.endpoint.current_value))
        // survey (top-level `survey: true` in hamon.yml): when the ETS DPT
        // cannot decode the telegram, log the raw payload so the real DPT can
        // be worked out
        if (opts.survey === true && ga.endpoint.current_value === undefined && Buffer.isBuffer(value)) {
            log.info('DBRAW %s %s (%s) %s len=%d hex=%s', name, dest, ga.name, ga.type,
                        value.length, value.toString('hex'))
        }
        if (ga.type != undefined && ga.type != '') {
            const args = [evt, src, dest, name, ga.name, ga.type, ga.endpoint.current_value, ga.unit]
            if (dedupe) dedupe.push(dest, ga.endpoint.current_value, args)
            else writeEvent(...args)
        }
    }

    function connect(knxAddr, secureTunnel) {
        connection = knx.Connection({
            ipAddr: knxAddr,
            ipPort: port,
            // these set based on device type
            forceTunneling: device == "generic" ? true : false,
            suppress_ack_ldatareq: (device == "loxone" || device == "eibport") ? true : false,
            physAddr: phyAddr,
            site: name,             // knxultimate only: labels the library's own lines
            log,                    // knxultimate only: the shim's lines
            secure: secureTunnel,   // knxultimate only; undefined = plain tunnelling
            loglevel: quietRetries ? 'error' : logging,
            handlers: {
                connected: guard(function () {
                    log.info('%s Connected - %s (%d)', ctime(), name, Date.now() - lastErr)
                    hooks.connected() // resets restart back-off
                    clearTimeout(firstConnectHandle)
                    firstConnectHandle = null
                    if (timerHandle != null) {
                        clearTimeout(timerHandle)
                        timerHandle = null
                        log.info('%s Timer: clear timer %s', ctime(), name)
                    }
                    if (!inited) { // only do this once on initial load
                        inited = true
                        initDatapoints()
                        // and then connect to MQTT
                        mqttClient = MQTTconnect(groupAddresses, connection, location, log)
                    }
                }),
                // on event we get src/dest/value
                event: guard(onEvent),
                error: guard(function (connstatus) {
                    lastErr = Date.now()
                    // a never-connected site retrying after its first give-up fails the same
                    // way each time (knxultimate reports it here, knx didn't): keep it out of
                    // error.log - the first attempt after a start or config change still errors
                    log.log(quietRetries ? 'info' : 'error', '%s **** ERROR: %s %j', ctime(), name, connstatus)
                    // the recovery timer runs from the FIRST error since the last
                    // 'connected' and is not re-armed by later ones: a stack that keeps
                    // failing more often than every 15min would otherwise push the
                    // restart back for ever. 'connected' clears it
                    if (timerHandle == null) {
                        timerHandle = setTimeout(() => handleTimeout(), ERROR_WAIT)
                    }
                }),
            },
        })
    }

    async function start() {
        if (opts.connectedBefore !== true) {
            firstConnectHandle = setTimeout(() => {
                log.info('%s: not connected within %d min', name, FIRST_CONNECT_WAIT / 60000)
                handleTimeout()
            }, FIRST_CONNECT_WAIT)
        }
        quietDptlib(logging)

        let knxAddr = null
        try {
            knxAddr = (await dnsp.lookup(String(dns), { family: 4 })).address
        } catch (e) {
            // unresolved below
        }
        if (finished) return // stopped while resolving
        log.info('KNXnet/IP %s -> %s (stack %s, decoder %s%s%s)', dns, knxAddr, siteStack || 'knx', decoder,
                    dedupe ? `, dedupe ${opts.dedupe / 1000}s` : '',
                    opts.precheck === true ? ', checking the gateway answers first' : '')
        // unresolved: knx would silently fall back to the multicast default and
        // look 'connected' with no data - so stop before any tunnel attempt and
        // say why; service.js blocks the site (no timed retry) until its
        // hamon.yml entry changes or it is kpiped
        if (knxAddr == null) return finish(hooks.stopped, 'dns', `DNS lookup failed for ${dns}`)

        // KNX Secure tunnelling: the values come from .hamon-secrets.json (see
        // secrets.js); anything missing or not matching the site throws
        let secureTunnel
        try {
            if (secure === true) {
                secureTunnel = secureOptions(path, { ...location, stack: siteStack })
                log.info('%s: KNX Secure tunnel %s (user %d) on gateway %s, %d Data Secure GA(s)', name,
                    secureTunnel.tunnelIA, secureTunnel.userId, secureTunnel.gateway,
                    Object.keys(secureTunnel.groupKeys).length)
            }
            groupAddresses = loadGroupAddresses()
            loadmapping(path) // initialise the str to dtp mappings
        } catch (err) {
            return finish(hooks.error, err)
        }

        // a site that hasn't connected recently (service.js decides: none in the
        // last 7 days, from tmp/site-state.json) first checks the gateway is
        // there at all; no reply: stop before any tunnel attempt and say why
        if (opts.precheck === true) {
            const answered = await describe(knxAddr, port)
            if (finished) return
            if (!answered) {
                return finish(hooks.stopped, 'unreachable', `no reply to DESCRIPTION from ${knxAddr}:${port}`)
            }
        }
        try {
            connect(knxAddr, secureTunnel)
        } catch (err) {
            finish(hooks.error, err)
        }
    }

    // close the tunnel (waiting up to STOP_WAIT for the gateway's reply) and MQTT,
    // clear the timers. Safe to call more than once
    function stop() {
        if (stopping) return stopping
        if (dedupe) dedupe.flushAll() // held repeats are written, not lost
        clearTimeout(firstConnectHandle)
        clearTimeout(timerHandle)
        firstConnectHandle = timerHandle = null
        mqdisconnect(mqttClient)
        mqttClient = null
        stopping = new Promise((resolve) => {
            if (connection == null) return resolve()
            // an open tunnel: wait for the gateway to confirm the DISCONNECT
            // (or STOP_WAIT). Any other state (e.g. retrying): Disconnect() is
            // still called, as in one thread nothing else would stop the
            // stack's retries - a worker's exit used to do that
            const open = connection.state === 'connected' || connection.state === 'idle'
            const t = setTimeout(resolve, open ? STOP_WAIT : 0)
            if (open) {
                connection.on('disconnected', () => {
                    clearTimeout(t)
                    console.log(`[${name}] Disconnected, closed connection gracefully.`)
                    resolve()
                })
            }
            try {
                connection.Disconnect()
            } catch (err) {
                clearTimeout(t)
                resolve()
            }
        }).then(() => {
            if (connection != null && typeof connection.removeAllListeners === 'function') {
                connection.removeAllListeners()
            }
            connection = null
            groupAddresses = {}
        })
        return stopping
    }

    // an exit asked for by service.js (config change, kpipe, shutdown): no hook
    function exit() {
        log.info('Exiting - doing cleanup for: %s', name)
        finished = true
        return stop()
    }

    return { name, start, stop: exit }
}

module.exports = { createSite }
