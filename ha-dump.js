#!/usr/bin/env node
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
const fs = require('fs');
const yargs = require('yargs');

configFile = "hamon.yml"; // default configuration file

// parse command line args
const argv = yargs
  .command('* <loca>')
  .option('c', {
    alias: 'config',
    description: 'The configuration file',
    type: 'string',
    nargs: 1,
  })
  .scriptName("ha-dump")
  .usage("Usage: $0 [-c config-file] location")
  .argv;

if (argv.config) {
  //console.log('Optional configuration file specified: %s', argv.config);
  configFile = argv.config;
}
loc = argv.loca; // the location

// check command args
/*
var loc = process.argv[2];
if (loc == undefined || loc == "") {
    console.log ("usage: %s [-c {config.yml}] {location}", process.argv[1]);
    return 1;
}
*/

// and configuration file
if (fs.existsSync("./" + configFile)) {
  console.log("Using configuration file: %s for location: %s", configFile, loc);
} else {
  console.log("Configuration file %s doesn't exist", configFile);
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
    logging = install['logging'];
    phyAddr = install['phyAddr'];
  }
}

// check if location found
if (knxnetLoc == "") {
  console.log("Location %s not found", loc);
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
  physAddr: phyAddr, // from config
  loglevel: logging,
  handlers: {
    connected: function () {
      console.log('Connected!')
      // DO THINGS HERE
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

function exitHandler(options) {
  if(connection.state === 'connected' || connection.state === 'idle') {
    console.log('Connection is established while trying to close ha-dump script, disconnecting...')
    // As Disconnect requires cb, otherwise it crashes, we pass dummy cb and handle with events (Fixes 2.5.1 knx issue)
    connection.Disconnect(() => null)
    connection.on('disconnected', () => {
      console.log('Disconnected, closing ha-dump gracefully.')
      if (options.exit) process.exit();
    })
  } else {
    if (options.exit) process.exit();
  }
}

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, { exit: true }));

// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler.bind(null, { exit: true }));
process.on('SIGUSR2', exitHandler.bind(null, { exit: true }));

//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, { exit: true }));
