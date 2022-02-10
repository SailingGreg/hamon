/*
 * Program to list the themostat and store in influxDB
 *
 *
*/

// load knx ip stack
var knx = require('knx');
const Influx = require('influx');
var dnsSync = require('dns-sync');
const logger = require('./src/logger');

inited = false; // guard condition

var knxnetIP = "ha-test.dyndns.org";
var knxAddr = "";
var knxPort = 50001;

// resolve the KNXnet/IP router
knxAddr = dnsSync.resolve(knxnetIP);
logger.info('KNXnet/IP %s -> %s', knxnetIP, knxAddr);

// create the influxDB connection
const influx = new Influx.InfluxDB({
  host: 'localhost',
  database: 'hamon',
  username: 'grafana',
  password: 'Grafana',
  schema: [
    {
      // the database 'table'
      measurement: 'knx',
      // we have INTEGER, FLOAT, STRING & BOOLEAN,
      fields: { value: Influx.FieldType.FLOAT },
      tags: ['groupaddr', 'source']
    }
  ]
});


// handle datapoint
let knxEvent = function(evt, value, dp) {

    //logger.info("knxEvent");
    // dpt.subtype have name, desc, unit and range
    dpdesc = dp.dpt.subtype.desc;
    dpunit = dp.dpt.subtype.unit;
    dpga = dp.options.ga;
    //logger.info("knxEvent - after refs");

    // need to check the evt type - is it Write!
    logger.info("%s **** %j %j reports: %j (%j %j)",
		new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
		dpga, evt, value, dpdesc, dpunit);

   // need a guard as a GroupValue_Read has no value!
   if (evt == "GroupValue_Write" || evt == "GroupValue_Response") {
            // define the event type - Write or Response

	// write to influxDB
	const date = new Date();
	influx.writePoints([
	    {
		measurement: 'knx',
		tags: {
		  groupaddr: "0/1/0",
		  source: "1.1.14",
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
}


// and create connection
var connection = knx.Connection({

 // the following is the ip address for ha-test.dyndns.org
 ipAddr: knxAddr, ipPort: knxPort,
 // may be incorrect
 //physAddr: '0.1.0',
 // ensure it tunneling and not operating n hybrid mode
 forceTunneling: true,
 // the defaut is info
 //loglevel: 'debug',
 handlers: {
  connected: function() {
    logger.info('Connected!');

    // read temp
    // this is temp on 1.1.14
    var tdpga = '0/1/0'; // the ga address for thermostat
    var tdptype = 'DPT9.001'; // and the type

    // avoid creating multipe datapoints on reconnection
    if (inited == false) {
        logger.info("inited");
        let dp = new knx.Datapoint({ga: tdpga, dpt: 'DPT9.001'}, connection);

        // need a guard to only do this once!!!
        dp.on('event', function(evt, value) {
                   knxEvent(evt, value, dp);
        });

	inited = true;
    }

  }, // end connect:
 /*
  event: function (evt, src, dest, value) {
   logger.info("%s **** KNX EVENT: %j, src: %j, dest: %j, value: %j",
    new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
    evt, src, dest, value);
  },
 */
  error: function(connstatus) {
      logger.error("**** ERROR: %j", connstatus);
  }
 }
});


