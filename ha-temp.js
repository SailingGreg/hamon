/*
 * Program to list the themostat and store in influxDB
 *
 *
*/

// load knx ip stack
var knx = require('knx');
const Influx = require('influx');

inited = false; // guard condition

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

    //console.log("knxEvent");
    // dpt.subtype have name, desc, unit and range
    dpdesc = dp.dpt.subtype.desc;
    dpunit = dp.dpt.subtype.unit;
    dpga = dp.options.ga;
    //console.log("knxEvent - after refs");

    // need to check the evt type - is it Write!
    console.log("%s **** %j %j reports: %j (%j %j)",
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
	      console.error(`Error saving data to InfluxDB! ${error.stack}`)
	     });
    }
}


// and create connection
var connection = knx.Connection({

 // the following is the ip address for ha-test.dyndns.org
 //ipAddr: '92.15.30.220', ipPort: 50001,
 //ipAddr: '92.19.140.228', ipPort: 50001,
 ipAddr: '92.15.29.57', ipPort: 50001,
 // may be incorrect
 //physAddr: '0.1.0',
 // ensure it tunneling and not operating n hybrid mode
 forceTunneling: true,
 // the defaut is info
 //loglevel: 'debug',
 handlers: {
  connected: function() {
    console.log('Connected!');

    // read temp
    // this is temp on 1.1.14
    var tdpga = '0/1/0'; // the ga address for thermostat
    var tdptype = 'DPT9.001'; // and the type

    // avoid creating multipe datapoints on reconnection
    if (inited == false) {
        console.log("inited");
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
   console.log("%s **** KNX EVENT: %j, src: %j, dest: %j, value: %j",
    new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
    evt, src, dest, value);
  },
 */
  error: function(connstatus) {
      console.log("**** ERROR: %j", connstatus);
  }
 }
});


