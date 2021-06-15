const knx = require('knx')
const { workerData, parentPort } = require('worker_threads')
const ets = require('../parsexml')
const logger = require('./logger')
const { writeEvents } = require('./db')
const dnsSync = require('dns-sync')
const { MQTTconnect, mqdisconnect } = require('./mqwrite')
// added device so switch can be appropriate
const { dns, port, config, name, path, logging, device, phyAddr } = workerData?.location

// exit if signaled
parentPort.on("message", (value) => {
	if (value.exit) {
	    logger.info("Exiting - doing cleanup for: %s", name);
	    // tidyup
            connection.Disconnect();
            // should also tidyup MQTT thread
            mqdisconnect();
	    process.exit(0);
	}
    });

function handleTimeout() {
    let ctime = localDate().replace(/T/, ' ').replace(/\..+/, '');
    // added name so it gets picked up
    logger.info('%s Timer: connection timed out %s', ctime, name);

    connection.Disconnect();
    //
    // pass the 'location' back to the parent for 'restart'
    parentPort.postMessage( name );
    //
    // and then just exit
    process.exit(1);
}

var timerHandle = null; // the link for the timer

const knxAddr = dnsSync.resolve(dns)

logger.info('KNXnet/IP %s -> %s', dns, knxAddr)

//console.log("connection.js %s", path);
const groupAddresses = ets.parsexml(path + config) || {}

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
        ctime = localDate().replace(/T/, ' ').replace(/\..+/, '')
        logger.info('%s Connected - %s (%d)', ctime, name, ld - last_err);

        if (timerHandle != null) {
            clearTimeout(timerHandle);
            timerHandle = null; // nulled as clear does not change it!
            logger.info('%s Timer: clear timer %s', ctime, name);
        }

        if (inited == false) {
        inited = true
        // need to iterate over the groupAddresses and create the dps
        var cnt = 0;
        var udefined = 0;
        for (let key in groupAddresses) {
            // debugging on load
          if (groupAddresses.hasOwnProperty(key)) {
            // how do check if DPT is defined?

            // defines default TIME
            if (groupAddresses[key].dpt == undefined &&
                    groupAddresses[key].name.substr(0, 5) == "Time " ) {
                    //console.log ("Time entry: ", groupAddresses[key].name);
                    groupAddresses[key].dpt = "DPT10.001"
            }
            // and handles non define room 'temp' - 'Actual temp' also
            if (groupAddresses[key].dpt == undefined &&
                    (groupAddresses[key].name.includes(" Room temp") ||
                    groupAddresses[key].name.includes(" Actual temp")) ) {
                    //console.log ("Room temp: ", groupAddresses[key].name);
                    groupAddresses[key].dpt = "DPT9.001"
            }
            // hack for one more deployment missing a definition
            if (groupAddresses[key].dpt == undefined &&
                    groupAddresses[key].name.includes(" Boiler") ) {
                    //console.log ("Room temp: ", groupAddresses[key].name);
                    groupAddresses[key].dpt = "DPT1.001"
            }

            //console.log("New dp %d %j", cnt, groupAddresses[key].dpt);
              // add default subtype if not defined
              if (groupAddresses[key].dpt == "DPT1")
                groupAddresses[key].dpt = groupAddresses[key].dpt + ".001"
              if (groupAddresses[key].dpt == "DPT5")
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
        logger.info('Processed %j (%d undefined) groupAddresses[]: ',                                                                           cnt, udefined)
        // and then connect to MQTT
        MQTTconnect(groupAddresses, connection, workerData?.location)
      }
    },
    // on event we get src/dest/value
    event: function (evt, src, dest, value) {
      if (groupAddresses.hasOwnProperty(dest)) {
        ctime = localDate().replace(/T/, ' ').replace(/\..+/, '')

        logger.info(
          '>> %s Event %s %j -> %j (%s - %s) - %j %s %j',
          ctime,
	        evt,
          src,
          dest,
          groupAddresses[dest].name,
          groupAddresses[dest].type,
          groupAddresses[dest].endpoint.current_value,
          groupAddresses[dest].unit,
          typeof(groupAddresses[dest].endpoint.current_value)
        )
        // encode the evt to shorten it - "gw" or "re"
        if (groupAddresses[dest].type != undefined 
                && groupAddresses[dest].type != '') { // if type
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
        }
      }
    },
    error: function (connstatus) {
        last_err = new Date().getTime(); // note the time
        ctime = localDate().replace(/T/, ' ').replace(/\..+/, '');
        logger.error('%s **** ERROR: %s %j', ctime, name, connstatus);

        // set timer for 5 mins for testing
        timerHandle = setTimeout (() => handleTimeout(), 300 * 1000);
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
