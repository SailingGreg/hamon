/*
 * connection.js - handle the connection to the remote device
 *
 *
 *
 */

const knx = require('knx')
const { workerData, parentPort } = require('worker_threads')
const ets = require('../parsexml')
const logger = require('./logger')
const { writeEvents } = require('./db')
const { writeEventsv2 } = require('./dbv2')
const dnsSync = require('dns-sync')
const { MQTTconnect, mqdisconnect } = require('./mqwrite')
//const strtodpt = require('./strtodpt')
const { loadmapping, mapstring } = require('./strtodpt')
// added device so switch can be appropriate
const { dns, port, config, name, path, influxver, logging, device, phyAddr } = workerData?.location

// exit if signaled
parentPort.on("message", (value) => {
	if (value.exit) {
            logger.info("Exiting - doing cleanup for: %s", name);
            // tidyup
            // this this need a guard as it throws an error if not connected
            // if (connection.state === 'connected' || connection.state === 'idle' )
            connection.Disconnect();
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

const knxAddr = dnsSync.resolve(dns)

logger.info('KNXnet/IP %s -> %s', dns, knxAddr)

//console.log("connection.js %s", path);
const groupAddresses = ets.parsexml(path + config) || {}

// load str to dtp mappings
loadmapping(path); // initialise
//const mapper = new strtodpt.strtodpt(path);
//const mapper = new strdpt.strtodpt(path);

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
  forceTunneling: device == "genric" ? true : false,
  suppress_ack_ldatareq: (device == "loxone" || device == "eibport") ? true : false,
  physAddr: phyAddr,
  loglevel: logging,
  handlers: {
    connected: function () {
        ld = new Date().getTime(); // time
        let ctime = localDate().replace(/T/, ' ').replace(/\..+/, '')
        logger.info('%s Connected - %s (%d)', ctime, name, ld - last_err);

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
        for (let key in groupAddresses) {
            // debugging on load
          if (groupAddresses.hasOwnProperty(key)) {
            // how do check if DPT is defined?

            // map name string to dtp
            if (groupAddresses[key].dpt == undefined) {
                    groupAddresses[key].dpt =
                            mapstring(name, groupAddresses[key].name);
                if (groupAddresses[key].dpt != undefined)
                    remapped++;
            }


            //console.log("New dp %d %j", cnt, groupAddresses[key].dpt);
              // add default subtype if not defined
            if (groupAddresses[key].dpt == "DPT1")
                groupAddresses[key].dpt = groupAddresses[key].dpt + ".001"
            if (groupAddresses[key].dpt == "DPT5")
                groupAddresses[key].dpt = groupAddresses[key].dpt + ".001"
            if (groupAddresses[key].dpt == "DPT9")
                groupAddresses[key].dpt = groupAddresses[key].dpt + ".001"
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
        logger.info('GA for %s: %j (%d undefined/%d remapped)',
                                            name, cnt, udefined, remapped);
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
