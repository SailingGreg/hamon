/*
 Simple script to test knx.js and validate connectivity
 It will list all events exposed on the bus via the KNX/IP router

*/

// load knx ip stack
var knx = require('knx');

// and create connection
var connection = knx.Connection({

 // the following is the ip address for ha-test.dyndns.org
 // as the module needs ipv4/ipv6 address
 // ipAddr: '92.15.30.220', ipPort: 50001, - old
 ipAddr: '92.19.140.228', ipPort: 50001,
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
  GroupValue_Read: function (src, dest) {
   console.log("%s **** KNX READ: src: %j, dest: %j",
    new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
    src, dest);
  },
  GroupValue_Response: function (src, dest, value) {
   console.log("%s **** KNX RESPONSE: src: %j, dest: %j, value %j",
    new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
    src, dest, value);
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
