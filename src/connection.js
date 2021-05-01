const knx = require('knx')
const { workerData, parentPort } = require('worker_threads')
const ets = require('../parsexml')
const logger = require('./logger')
const { writeEvents } = require('./db')
const dnsSync = require('dns-sync')

const { dns, port, config, name, path } = workerData?.location

// exit if signaled
parentPort.on("message", (value) => {
	if (value.exit) {
	    console.log("doing cleanup for: %s", name);
	    // connection.close???
	    process.exit(0);
	}
    });

const knxAddr = dnsSync.resolve(dns)

logger.info('KNXnet/IP %s -> %s', dns, knxAddr)

//console.log("connection.js %s", path);
const groupAddresses = ets.parsexml(path + config) || {}

let inited = false
let dp = '' // the datapoint
// and create connection
const connection = knx.Connection({
  ipAddr: knxAddr,
  ipPort: port,
  forceTunneling: true,
  handlers: {
    connected: function () {
      logger.info('Connected - %s', name)
      if (inited == false) {
        var tdpga = '0/1/0'
        dp = new knx.Datapoint({ ga: tdpga, dpt: 'DPT9.001' }, connection)
        inited = true
        // need to iterate over the groupAddresses and create the dps
        var cnt = 0
        for (let key in groupAddresses) {
          if (groupAddresses.hasOwnProperty(key)) {
            // construct dp for the group address
            let dp = new knx.Datapoint(
              { ga: key, dpt: groupAddresses[key].dpt },
              connection
            )
            //console.log("New dp %j", dp.dpt.subtype.name);
            groupAddresses[key].endpoint = dp
            groupAddresses[key].unit =
              dp.dpt.subtype !== undefined ? dp.dpt.subtype.unit || '' : ''
            groupAddresses[key].type =
              dp.dpt.subtype !== undefined ? dp.dpt.subtype.name || '' : ''
            cnt = cnt + 1
          }
        }
        logger.info('Processed %j groupAddresses[]: ', cnt)
      }
    },
    // on event we get src/dest/value
    event: function (evt, src, dest, value) {
      if (groupAddresses.hasOwnProperty(dest)) {
        ctime = localDate().replace(/T/, ' ').replace(/\..+/, '')

        logger.info(
          '>> %s Event %j -> %j (%s - %s) - %j %s',
          ctime,
          src,
          dest,
          groupAddresses[dest].name,
          groupAddresses[dest].type,
          groupAddresses[dest].endpoint.current_value,
          groupAddresses[dest].unit
        )
        // encode the evt to shorten it - "gw" or "re"
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
    },
    error: function (connstatus) {
      logger.error('**** ERROR: %j', connstatus)
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
