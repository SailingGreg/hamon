/*
 Simple script to test knx.js and validate connectivity
 It will list all events exposed on the bus via the KNXnet/IP router

*/

// load knx ip stack
var knx = require('knx');
//const dns = require('dns');
var dnsSync = require('dns-sync');
const yaml = require('js-yaml');
const fs   = require('fs');

var knxnetIP = "ha-test.dyndns.org";
var knxAddr = "";
var knxPort = 50001;

fileArg = "hamon.yml";

//console.log(process.argv);
var knxLoc = process.argv[2];
if (knxLoc == undefined || knxLoc == "") {
    console.log ("usage: %s {location}", process.argv[1]);
    return 1;
}

if (fs.existsSync("./" + fileArg)) {
    console.log ("Parsing configuration file %s", fileArg);
} else {
    console.log ("Configuration file %s doesn't exist", fileArg);
    return 1;
}

// this parse and expands the configuration
const doc = yaml.load(fs.readFileSync(fileArg, 'utf8'));
cnt = 0;
for (deploy in doc["locations"]) {
    cnt = cnt + 1;
    install = doc["locations"][deploy]
    console.log("\t %s %s %s %d", deploy, install['name'], install['dns'], install['port']);
    if (install['name'] == knxLoc) {
        knxnetIP = install['dns'];
        knxnetPort = install['port'];
        knxnetXML = install['config'];
    }
}

// resolve the KNXnet/IP router
console.log("Running for %s ", knxLoc);

// resolve the KNXnet/IP router
knxAddr = dnsSync.resolve(knxnetIP);
console.log('KNXnet/IP %s -> %s', knxnetIP, knxAddr);

// and create connection
var connection = knx.Connection({

 // the following is the ip address for ha-test.dyndns.org
 // as the module needs ipv4/ipv6 address
 ipAddr: knxAddr, ipPort: knxPort,
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
