/*
 * connection.js - handle the connection to the remote device
 *
 *
 *
 */

const { workerData, parentPort } = require('worker_threads')
const ets = require('../parsexml')
const logger = require('./logger')
const { writeEvents } = require('./db')
const { writeEventsv2 } = require('./dbv2')
const dnsSync = require('dns-sync')
const { MQTTconnect, mqdisconnect } = require('./mqwrite')
//const strtodpt = require('./strtodpt')
const { loadmapping, mapstring, mapaddress } = require('./strtodpt')
const fs = require('fs');
// added device so switch can be appropriate
const { dns, port, config, name, path, influxver, logging, device, phyAddr, stack, secure, survey } = workerData?.location
const { secureOptions } = require('./secrets')

// label everything this worker prints (knx library warnings, stray console.log)
// with the site name, so lines in hamon.log say which site they came from -
// our own logger calls go to combined.log and already carry the name
for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream)
    let lineStart = true
    stream.write = (chunk, ...rest) => {
        if (typeof chunk !== 'string') {
            chunk = chunk.toString()
            if (typeof rest[0] === 'string') rest.shift() // encoding was for the buffer
        }
        const out = (lineStart ? `[${name}] ` : '') + chunk.replace(/\n(?=.)/g, `\n[${name}] `)
        lineStart = chunk.endsWith('\n')
        return write(out, ...rest)
    }
}
// knx's dptlib (used by both stacks) logs through log-driver's default logger,
// which is created at 'trace', so every DPT 20/21 decode printed a [debug]
// 'fromBuffer' line whatever the site's logging. Quieten it to the site's level:
// the levels below it become no-ops on the object dptlib holds
{
    const defaultLog = require('log-driver').logger
    const levels = defaultLog.levels
    const keep = levels.includes(logging) ? levels.indexOf(logging) : levels.indexOf('info')
    levels.forEach((lvl, i) => { if (i > keep) defaultLog[lvl] = () => {} })
}

// knx (default) or knxultimate - same API either way, see knxstack.js
const knx = require('./knxstack')(stack)

// exit if signaled
parentPort.on("message", (value) => {
	if (value.exit) {
            logger.info("Exiting - doing cleanup for: %s", name);
            // tidyup
            // this this need a guard as it throws an error if not connected
            if (connection.state === 'connected' ||
                                    connection.state === 'idle' ) {
                connection.Disconnect();
            }
            // should also tidyup MQTT thread
            mqdisconnect();

            // we may end up here if the process has hang or disconnected
            if (connection.state === 'connected' || connection.state === 'idle' ) {
                connection.on('disconnected', () => {
                  console.log('Disconnected, closed connection gracefully.')
                  process.exit(0);
                })
            } else {
                  process.exit(0);
            }
	}
    });

function handleTimeout() {
    let ctime = localDate().replace(/T/, ' ').replace(/\..+/, '');
    // added name so it gets picked up
    logger.info('%s >>> Timer connection timed out: %s', ctime, name);

    // disconnect knx and mqtt
    connection.Disconnect();
    mqdisconnect();

    // pass the 'location' back to the parent for 'restart'
    parentPort.postMessage( name );

    // and then just exit
    logger.info('%s >>> Worker exiting ... %s', ctime, name);
    if (connection.state === 'connected' || connection.state === 'idle' ) {
        connection.on('disconnected', () => {
          console.log('Closed connection with timeout.')
          process.exit(1);
        })
    } else {
          process.exit(1);
    }
}

var timerHandle = null; // the link for the timer

// a site that has never connected since hamon started (dead, or not there yet)
// would otherwise retry forever inside the KNX stack, logging every few
// seconds; after FIRST_CONNECT_WAIT give up and let service.js restart it with
// back-off (up to 4h). Sites that have connected before keep retrying here.
const FIRST_CONNECT_WAIT = 5 * 60 * 1000 // 5min
var firstConnectHandle = null
if (workerData?.connectedBefore !== true) {
    firstConnectHandle = setTimeout(() => {
        logger.info('%s: not connected within %d min', name, FIRST_CONNECT_WAIT / 60000);
        handleTimeout();
    }, FIRST_CONNECT_WAIT);
}
// once such a site has given up, its restarts keep the stack quiet - otherwise
// it logs 'connection timed out, retrying...' every few seconds each time
const quietRetries = workerData?.connectedBefore !== true && (workerData?.failures || 0) > 0

const knxAddr = dnsSync.resolve(dns)

logger.info('KNXnet/IP %s -> %s (stack %s)', dns, knxAddr, stack || 'knx')

// unresolved: knx would silently fall back to the multicast default and look
// 'connected' with no data - so fail; service.js logs it and retries with
// back-off (thrown rather than logged here as the worker exits before flush)
if (knxAddr == null) {
    throw new Error(`DNS lookup failed for ${dns}`);
}

// KNX Secure tunnelling: the values come from .hamon-secrets.json (see
// secrets.js); anything missing or not matching the site throws, as above
let secureTunnel
if (secure === true) {
    secureTunnel = secureOptions(path, workerData.location)
    logger.info('%s: KNX Secure tunnel %s (user %d) on gateway %s, %d Data Secure GA(s)', name,
        secureTunnel.tunnelIA, secureTunnel.userId, secureTunnel.gateway,
        Object.keys(secureTunnel.groupKeys).length)
}

//console.log("connection.js %s", path);

// READ CONFIG FILE
// add 'config' for file move
const configFilePath = path + 'config/' + config
let groupAddresses = {}
const configFileExtension = config.substring(config.lastIndexOf('.'), config.length)

//if(configFileExtension === '.json') {
if(configFileExtension === '.knxproj') {
  // config is json no need to parse it - but need to change extn
    var configFile = configFilePath.substring(0, configFilePath.lastIndexOf('.')) + '.json'

    logger.info(`Loading json intermediate file: ${configFile}`);
  let rawdata = fs.readFileSync(configFile);
  groupAddresses = JSON.parse(rawdata).reduce(function(map, obj) {
    map[obj.address] = obj;
    return map;
  }, {});
} else {
    // load the xml export
  groupAddresses = ets.parsexml(configFilePath) || {}
}

// load str to dtp mappings
loadmapping(path); // initialise
//const mapper = new strtodpt.strtodpt(path);
//const mapper = new strdpt.strtodpt(path);

// default subtype for an ETS DPT given as the main type only (see below)
const DEFAULT_SUBTYPE = { DPT1: '.001', DPT3: '.007', DPT5: '.001', DPT7: '.001', DPT8: '.001', DPT9: '.001', DPT18: '.001' }

let last_err = new Date().getTime(); // time
let ld = 0;
let inited = false
let dp = '' // the datapoint
// and create connection
const connection = knx.Connection({
  ipAddr: knxAddr,
  ipPort: port,
  // these set based on device type
  //forceTunneling: false,
  forceTunneling: device == "generic" ? true : false,
  suppress_ack_ldatareq: (device == "loxone" || device == "eibport") ? true : false,
  physAddr: phyAddr,
  secure: secureTunnel,   // knxultimate only; undefined = plain tunnelling
  loglevel: quietRetries ? 'error' : logging,
  handlers: {
    connected: function () {
        ld = new Date().getTime(); // time
        let ctime = localDate().replace(/T/, ' ').replace(/\..+/, '')
        logger.info('%s Connected - %s (%d)', ctime, name, ld - last_err);
        parentPort.postMessage({ connected: name }); // resets restart back-off
        if (firstConnectHandle != null) {
            clearTimeout(firstConnectHandle);
            firstConnectHandle = null;
        }

        if (timerHandle != null) {
            clearTimeout(timerHandle);
            timerHandle = null; // nulled as clear does not change it!
            logger.info('%s Timer: clear timer %s', ctime, name);
        }

        if (inited == false) { // only do this once on initial load
        inited = true;
        // need to iterate over the groupAddresses and create the dps
        var cnt = 0;
        var udefined = 0;
        let remapped = 0;
        let overridden = 0;
        for (let key in groupAddresses) {
            // debugging on load
          if (groupAddresses.hasOwnProperty(key)) {
            // how do check if DPT is defined?

            // an exact-address rule comes first: it can replace a wrong
            // ETS dpt ('override') and the misleading name that goes with it
            const arule = mapaddress(name, key);
            if (arule !== undefined) {
                if (arule.dpt !== undefined &&
                    (arule.override || groupAddresses[key].dpt == undefined)) {
                    if (groupAddresses[key].dpt == undefined)
                        remapped++;
                    else
                        overridden++;
                    groupAddresses[key].dpt = arule.dpt;
                }
                if (arule.name !== undefined)
                    groupAddresses[key].name = arule.name;
            }

            // map name string to dtp
            if (groupAddresses[key].dpt == undefined) {
                    groupAddresses[key].dpt =
                            mapstring(name, groupAddresses[key].name);
                if (groupAddresses[key].dpt != undefined)
                    remapped++;
            }


            //console.log("New dp %d %j", cnt, groupAddresses[key].dpt);
              // add a default subtype where ETS gave only the main type:
              // without one knx's dptlib gives no type name and the GA is never
              // stored. 3.007 (dimming) is the usual bare DPT3; DPT3 and DPT18
              // decode to objects, so they reach dbv2's composite (DBSKIP) path
            if (DEFAULT_SUBTYPE[groupAddresses[key].dpt] !== undefined)
                groupAddresses[key].dpt += DEFAULT_SUBTYPE[groupAddresses[key].dpt]
            // construct dp for the group address
            // note still doing this for undefined DPTs
            let dp = new knx.Datapoint(
              { ga: key, dpt: groupAddresses[key].dpt }, connection
            )
              //if (groupAddresses[key].dpt == "DPT1.001")
                //console.log("The dp is %j", dp.dpt);
                //console.log("New dp %d %j, %j", cnt, dp, dp.dpt.subtype.name);

                groupAddresses[key].endpoint = dp
                groupAddresses[key].unit =
                 dp.dpt.subtype !== undefined ? dp.dpt.subtype.unit || '' : ''
                groupAddresses[key].type =
                 dp.dpt.subtype !== undefined ? dp.dpt.subtype.name || '' : ''

            // set a guard if dpt is not defined for the key
            if (groupAddresses[key].dpt == undefined) {
                groupAddresses[key].type = undefined;
                udefined = udefined + 1;
            }
            cnt = cnt + 1
          }
        }
        logger.info('GA for %s: %j (%d undefined/%d remapped/%d overridden)',
                                name, cnt, udefined, remapped, overridden);
        // and then connect to MQTT
        MQTTconnect(groupAddresses, connection, workerData?.location)

        /*
        // done for network ip change testing
        if (name == "home")  {
            logger.info('%s >>> Disconnect timer set for: %s', ctime, name);
            timerHandle = setTimeout (() => handleTimeout(), 180 * 1000);
        }
        */
      }
    },
    // on event we get src/dest/value
    event: function (evt, src, dest, value) {
      if (groupAddresses.hasOwnProperty(dest)) {
        let ctime = localDate().replace(/T/, ' ').replace(/\..+/, '')

        // note use of endpoint.current_value gives the 'decoded' value
        logger.info(
          '>> %s Event %s %j -> %j (%s - %s) - %j %s %j',
          ctime, evt, src, dest,
          groupAddresses[dest].name,
          groupAddresses[dest].type,
          groupAddresses[dest].endpoint.current_value,
          groupAddresses[dest].unit,
          typeof(groupAddresses[dest].endpoint.current_value)
        )
        // survey (`survey: true` in hamon.yml): when the ETS DPT cannot decode
        // the telegram, log the raw payload so the real DPT can be worked out
        if (survey === true
                && groupAddresses[dest].endpoint.current_value === undefined
                && Buffer.isBuffer(value)) {
            logger.info('DBRAW %s %s (%s) %s len=%d hex=%s', name, dest,
              groupAddresses[dest].name, groupAddresses[dest].type,
              value.length, value.toString('hex'))
        }
        // encode the evt to shorten it - "gw" or "re"
        if (groupAddresses[dest].type != undefined 
                && groupAddresses[dest].type != '') { // if type
            // bind to influx v1 or v2?
            if (influxver == 1) {
                writeEvents(
                  evt,
                  src,
                  dest,
                  //knxnetLoc,
                  name,
                  groupAddresses[dest].name,
                  groupAddresses[dest].type,
                  groupAddresses[dest].endpoint.current_value,
                  groupAddresses[dest].unit
                )
            } else {
                writeEventsv2(
                  evt,
                  src,
                  dest,
                  //knxnetLoc,
                  name,
                  groupAddresses[dest].name,
                  groupAddresses[dest].type,
                  groupAddresses[dest].endpoint.current_value,
                  groupAddresses[dest].unit
                )
            }
        }
      }
    },
    error: function (connstatus) {
        last_err = new Date().getTime(); // note the time
        let ctime = localDate().replace(/T/, ' ').replace(/\..+/, '');
        logger.error('%s **** ERROR: %s %j', ctime, name, connstatus);

        // clear any pending recovery timer before re-arming: a burst of errors
        // before the next 'connected' would otherwise orphan earlier timers
        // (timerHandle is overwritten), and an orphan fires handleTimeout ~15min
        // later - a spurious full-worker restart even after the link recovered.
        if (timerHandle != null) {
            clearTimeout(timerHandle);
        }
        // set timer for ip changes - changed to 8min based on testing
        // 8min was not long enough for the network to stabilise
        // so changed to 15min - 15 * 60 -> 900
        timerHandle = setTimeout (() => handleTimeout(), 900 * 1000);
    }
  }
})
// return local date/time - this uses ISO structure
function localDate() {
  var date = new Date()
  var isoDateTime = new Date(
    date.getTime() - date.getTimezoneOffset() * 60000
  ).toISOString()
  return isoDateTime
}

module.exports.connection = connection
