/*
 * Simple script to test knx.js and validate connectivity
 * It will list all events exposed on the bus via the KNX/IP router
 * 
 * this parse and creates a dp for each groupaddress and on an event
 * if will record the value if it is associated with a group address
*/

// load knx ip stack
var knx = require('knx');
//const DPTLib = require('knx.dptlib');
//const dns = require('dns');
var dnsSync = require('dns-sync');
const ets = require('./parsexml');

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
    /*
   console.log("%s **** KNX EVENT: %j, src: %j, dest: %j, value: %j",
    new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
    evt, src, dest, value);
    */

    // check for dp.options.ga?
    //console.log("dp options: %j", dp.options.ga);

    // if this a known end point - record values
    if (groupAddresses.hasOwnProperty(dest)) {
        console.log(">> %s Event %j -> %j (%s) - %j %s",
    	    new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
 	    src, dest,
            groupAddresses[dest].name,
            groupAddresses[dest].endpoint.current_value,
            groupAddresses[dest].unit);

	// encode the evt to shorten it - "gw" or "re"
        /*
        writedb (evt, src, dest, name, value, unit);
        */
    }

    //if (dest == '0/1/0') {
    if (dest == dp.options.ga) {
	//var jsvalue = DPTLib.fromBuffer(value, dp.dpt);
        //console.log(">>> value: %j", dp.current_value);

        // relying on change() to update this
        var jsval = dp.current_value;

        //console.log(">> %j, src: %j, dest: %j, value: %j - %j",
    	//			evt, src, dest, value, jsval);
    }
  },

  error: function(connstatus) {
      console.log("**** ERROR: %j", connstatus);
  }
 }
});

// end of file
