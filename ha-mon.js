/*
 * File: ha-mon.js - monitor all exported group addresses
 *
 * this parse and creates a dp for each groupaddress and on an event
 * if will record the value if it is associated with a group address
 *
 *
*/

// load knx ip stack
var knx = require('knx');
//const DPTLib = require('knx.dptlib');
//const dns = require('dns');
var dnsSync = require('dns-sync');
const ets = require('./parsexml');
const Influx = require('influx');

// host and port - move to config file
var knxnetIP = "ha-test.dyndns.org";
var knxAddr = "";
var knxPort = 50001;

// resolve the KNXnet/IP router
knxAddr = dnsSync.resolve(knxnetIP);
console.log('KNXnet/IP %s -> %s', knxnetIP, knxAddr);

var inited = false;
var dp = ""; // the datapoint

// parse the ETS export for the GAs
let groupAddresses = ets.parsexml("ga.xml") || {};

// create the influxDB connection
const influx = new Influx.InfluxDB({
  host: 'localhost',
  database: 'hamon',
  username: 'grafana',
  password: 'Grafana',
  schema: [
    {
      // the database 'table'
      measurement: 'knx2',
      // we have INTEGER, FLOAT, STRING & BOOLEAN,
      fields: { value: Influx.FieldType.FLOAT },
      tags: ['event', 'source', 'groupaddr']
    }
  ]
});

// write to influxDB
let writeEvents = function (evt, src, dest, name, value, unit) {
    if (evt != "GroupValue_Write" && evt != "GroupValue_Response")
	return;

    // define the event type - Write or Response
    var evtType = (evt == "GroupValue_Write") ? "Write" : "Response";

    // write to influxDB
    const date = new Date();
    influx.writePoints([
	    {
		measurement: 'knx2',
		tags: {
		  event: evtType,
		  source: src,
		  groupaddr: dest,
		},
		fields: { value: value },
		timestamp: date,
	    }
	    ], {
	      database: 'hamon',
	      precision: 'ms',
	})
	    .catch(error => {
	      console.error(`Error saving data to InfluxDB! ${error.stack}`)
    });
}

// and create connection
var connection = knx.Connection({

 // the following is the ip address for ha-test.dyndns.org
 // as the module needs ipv4/ipv6 address
 // ipAddr: '92.15.30.220', ipPort: 50001, - old
 //ipAddr: '92.15.29.57', ipPort: 50001,
 ipAddr: knxAddr, ipPort: knxPort,
 //ipAddr: knxAddr, ipPort: 50001,
 // may be incorrect
 //physAddr: '0.1.0',
 // ensure it tunneling and not operating n hybrid mode
 forceTunneling: true,
 // the defaut is info
 //loglevel: 'debug',
 handlers: {
  connected: function() {
    console.log('Connected!');

    if (inited ==  false) { // only for this once
	// create single dp for temp
        var tdpga = '0/1/0';
        dp = new knx.Datapoint({ga: tdpga, dpt: 'DPT9.001'}, connection);
        //console.log("dp.options.ga - %s: ", dp.options.ga);

       inited = true;

       // need to iterate over the groupAddresses and create the dps
       var cnt = 0;
       for (let key in groupAddresses) {
           if (groupAddresses.hasOwnProperty(key)) {
		// construct dp for the groupaddress
               let dp = new knx.Datapoint({ga: key, dpt: groupAddresses[key].dpt}, connection);
               groupAddresses[key].endpoint = dp;
               groupAddresses[key].unit = dp.dpt.subtype !== undefined ? dp.dpt.subtype.unit || '' : '';
               cnt = cnt + 1;
           }
       }
       console.log("Processed %j groupAddresses[]: ", cnt);
    }
  },

  // on event we get src/dest/value
  event: function (evt, src, dest, value) {
    /* debug
   console.log("%s **** KNX EVENT: %j, src: %j, dest: %j, value: %j",
    new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
    evt, src, dest, value);
    */

    // check for dp.options.ga?

    // if this a known end point - record values
    if (groupAddresses.hasOwnProperty(dest)) {
        console.log(">> %s Event %j -> %j (%s) - %j %s",
    	    new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
 	    src, dest,
            groupAddresses[dest].name,
            groupAddresses[dest].endpoint.current_value,
            groupAddresses[dest].unit);

	// encode the evt to shorten it - "gw" or "re"
        writeEvents (evt, src, dest, 
            groupAddresses[dest].name,
            groupAddresses[dest].endpoint.current_value,
            groupAddresses[dest].unit);
    }

  },

  error: function(connstatus) {
      console.log("**** ERROR: %j", connstatus);
  }
 }
});

// end of file
