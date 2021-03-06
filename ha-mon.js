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
const winston = require('winston');
const yaml = require('js-yaml');
const fs   = require('fs');

// host and port - move to config file
var knxnetIP = "ha-test.dyndns.org";
var knxAddr = "";
var knxPort = 50001;
var knxLoc = "";

// set the location/path - done in systemd service file
//console.log(process.env); 
let home = process.env.HOME; // check for HOST=ha-test
if (typeof home == 'undefined') {
    var loc = "/home/pi/hamon/";
} else 
    var loc = home + "/hamon/";

// return local date/time - this uses ISO structure
function localDate() {
    var date = new Date();
    var isoDateTime = new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString();

    //new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
    return isoDateTime;
}

// create the logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.splat(),
    winston.format.simple(),
  ),
  defaultMeta: { service: 'ha-mon' },
  transports: [
    //
    // - Write all logs with level `error` and below to `error.log`
    // - Write all logs with level `info` and below to `combined.log`
    //
    new winston.transports.File({ filename: loc+'error.log', level: 'error' }),
    new winston.transports.File({ filename: loc+'combined.log' }),
  ],
});

// check for the YAML based configuration
const hamonConfig = loc + "hamon.yml"; // the configuration file - add location

if (fs.existsSync(hamonConfig)) {
    //file exists
    logger.info("Configuration file %s exists, parsing ...", hamonConfig);
} else {
    logger.error("Configuration file %s doesn't exist", hamonConfig);
    return false;
}

// this parse and expands the configuration
const doc = yaml.load(fs.readFileSync(hamonConfig, 'utf8'));
cnt = 0;
for (deploy in doc["locations"]) {
    cnt = cnt + 1;
    install = doc["locations"][deploy]
    logger.info("\t %s %s %s %d", deploy, install['name'], install['dns'], install['port']);
    if (install['name'] == "home") {
        knxnetLoc = install['name'];
        knxnetIP = install['dns'];
        knxnetPort = install['port'];
        knxnetXML = install['config'];
    }
}

// resolve the KNXnet/IP router
knxAddr = dnsSync.resolve(knxnetIP);
logger.info('KNXnet/IP %s -> %s', knxnetIP, knxAddr);

var inited = false;
var dp = ""; // the datapoint

// parse the ETS export for the GAs - added absolute path for SUSE
let groupAddresses = ets.parsexml(loc + knxnetXML) || {};
//let groupAddresses = ets.parsexml(loc + "ga.xml") || {};

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
      tags: ['location', 'event', 'source', 'groupaddr', 'name', 'type']
    }
  ]
});

// write to influxDB
let writeEvents = function (evt, src, dest, knxloc, name, type, value, unit) {
    if (evt != "GroupValue_Write" && evt != "GroupValue_Response") {
	return;
    }

    // define the event type - Write or Response
    var evtType = (evt == "GroupValue_Write") ? "Write" : "Response";

    // write to influxDB
    const date = new Date(); // this is UTC
    influx.writePoints([
	    {
		measurement: 'knx2',
		tags: {
		  location: knxloc,
		  event: evtType,
		  source: src,
		  groupaddr: dest,
		  name: name,
		  'type': type,
		},
		fields: { value: value },
		timestamp: date,
	    }
	    ], {
	      database: 'hamon',
	      precision: 'ms',
	})
	    .catch(error => {
	      logger.error(`Error saving data to InfluxDB! ${error.stack}`)
    });
}

// and create connection
var connection = knx.Connection({

 // the following is the ip address for ha-test.dyndns.org
 // as the module needs ipv4/ipv6 address
 // ipAddr: '92.15.30.220', ipPort: 50001, - old
 //ipAddr: '92.15.29.57', ipPort: 50001,
 ipAddr: knxAddr, ipPort: knxnetPort,
 // may be incorrect
 //physAddr: '0.1.0',
 // ensure it tunneling and not operating n hybrid mode
 forceTunneling: true,
 // the defaut is info
 //loglevel: 'debug',
 handlers: {
  connected: function() {
    logger.info('Connected!');

    if (inited ==  false) { // only for this once
	// create single dp for temp
        var tdpga = '0/1/0';
        dp = new knx.Datapoint({ga: tdpga, dpt: 'DPT9.001'}, connection);
        //logger.info("dp.options.ga - %s: ", dp.options.ga);

       inited = true;

       // need to iterate over the groupAddresses and create the dps
       var cnt = 0;
       for (let key in groupAddresses) {
           if (groupAddresses.hasOwnProperty(key)) {
		// construct dp for the groupaddress
               let dp = new knx.Datapoint({ga: key, dpt: groupAddresses[key].dpt}, connection);
		//console.log("New dp %j", dp.dpt.subtype.name);
               groupAddresses[key].endpoint = dp;
               groupAddresses[key].unit = dp.dpt.subtype !== undefined ? dp.dpt.subtype.unit || '' : '';
               groupAddresses[key].type = dp.dpt.subtype !== undefined ? dp.dpt.subtype.name || '' : '';
               cnt = cnt + 1;
           }
       }
       logger.info("Processed %j groupAddresses[]: ", cnt);
    }
  },

  // on event we get src/dest/value
  event: function (evt, src, dest, value) {
    /* debug
   ctime = localDate().replace(/T/, ' ').replace(/\..+/, '');
   logger.info("%s **** KNX EVENT: %j, src: %j, dest: %j, value: %j",
    ctime, evt, src, dest, value);
    */

    // check for dp.options.ga?

    // if this a known end point - record values
    if (groupAddresses.hasOwnProperty(dest)) {
    	ctime = localDate().replace(/T/, ' ').replace(/\..+/, '');
	
        logger.info(">> %s %s %j -> %j (%s - %s) - %j %s",
    	    ctime, evt,
 	    src, dest,
            groupAddresses[dest].name,
            groupAddresses[dest].type,
            groupAddresses[dest].endpoint.current_value,
            groupAddresses[dest].unit);

	//console.log("Endpoint %j", groupAddresses[dest].endpoint.dpt);


	// encode the evt to shorten it - "gw" or "re"
        writeEvents (evt, src, dest, knxnetLoc,
            groupAddresses[dest].name,
            groupAddresses[dest].type,
            groupAddresses[dest].endpoint.current_value,
            groupAddresses[dest].unit);
    }

  },

  error: function(connstatus) {
      logger.error("**** ERROR: %j", connstatus);
  }
 }
});

// end of file
