/*
 * Simple script to test knx.js and validate connectivity
 * It will list all events exposed on the bus via the KNXnet/IP router
 *
 */

//const { workerData } = require('worker_threads');

// load knx ip stack
var knx = require('knx');
var dnsSync = require('dns-sync');
const yaml = require('js-yaml');
const fs   = require('fs');

configFile = "hamon.yml";

// check command args
//console.log(process.argv);
var loc = process.argv[2];
if (loc == undefined || loc == "") {
    console.log ("usage: %s {location}", process.argv[1]);
    return 1;
}

// and configuration file
if (fs.existsSync("./" + configFile)) {
    console.log ("Using coniguration file %s", configFile);
} else {
    console.log ("Configuration file %s doesn't exist", configFile);
    return 1;
}

// then parse for location
const doc = yaml.load(fs.readFileSync(configFile, 'utf8'));
var cnt = 0;
var knxnetLoc = "";
for (deploy in doc["locations"]) {
    cnt = cnt + 1;
    install = doc["locations"][deploy]
    console.log("\t %s %s %s %d", deploy, install['name'], install['dns'], install['port']);
    if (install['name'] == loc) {
        knxnetLoc = install['name'];
        knxnetIP = install['dns'];
        knxnetPort = install['port'];
        knxnetXML = install['config'];
    }
}

// check if location found
if (knxnetLoc == "") {
    console.log ("Location %s not found", loc);
    return 1;
}
console.log("Dumping %s %s %d (%s)", knxnetLoc, knxnetIP, knxnetPort, knxnetXML);
// resolve the KNXnet/IP router
knxnetAddr = dnsSync.resolve(knxnetIP);

// and create connection
var connection = knx.Connection({
  // the following is the ip address for ha-test.dyndns.org
  // as the module needs ipv4/ipv6 address
  ipAddr: knxnetAddr,
  ipPort: knxnetPort,
  // may be incorrect
  // physAddr: '0.1.0',
  // ensure it tunneling and not operating n hybrid mode
  forceTunneling: true,
  // the default is info
  // logLevel: 'debug',
  handlers: {
    connected: function () {
      console.log('Connected!')
    },
    event: function (evt, src, dest, value) {
      console.log(
        '%s **** KNX EVENT: %j, src: %j, dest: %j, value: %j, name: %j',
        new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
        evt,
        src,
        dest,
        value, 
        loc
      )
    },
    error: function (connstatus) {
      console.log('**** ERROR: %j', connstatus)
    }
  }
})
