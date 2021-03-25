/*
 Simple script to test knx.js and validate connectivity
 It will list all events exposed on the bus via the KNXnet/IP router

*/

// load knx ip stack
var knx = require('knx');
//const dns = require('dns');
var dnsSync = require('dns-sync');

var knxnetIP = "ha-test.dyndns.org";
var knxAddr = "";
var knxPort = 50001;

// resolve the KNXnet/IP router
knxAddr = dnsSync.resolve(knxnetIP);
console.log('KNXnet/IP %s -> %s', knxnetIP, knxAddr);

// and create connection
var connection = knx.Connection({

 // the following is the ip address for ha-test.dyndns.org
 // as the module needs ipv4/ipv6 address
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
  },

  event: function (evt, src, dest, value) {
   console.log("%s **** KNX EVENT: %j, src: %j, dest: %j, value: %j",
    new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
    evt, src, dest, value);
  },

  error: function(connstatus) {
      console.log("**** ERROR: %j", connstatus);
  }
 }
});
