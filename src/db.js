/*
 * File: db.js - database writes
 *
 * code checks for type to ensure only 'numbers' are written to the
 * default shard otherwise InfluxDB will ignore the write
 *
 * Also check for undefined type where the DPT is not defined as this
 * results in an error as the tag is not defined on the write
 */

const Influx = require('influx')
const logger = require('./logger')
const dotenv = require('dotenv')

const result = dotenv.config({ path: __dirname + '/.env' });
if (result.error) {
    throw result.error;
}

// influxDB connection
const influx = new Influx.InfluxDB({
  host: 'localhost',
  database: process.env.DATABASE,
  username: process.env.USERNAME,
  password: process.env.PASSWORD,
  //database: 'hamon',
  //username: 'grafana',
  //password: 'Grafana',
  schema: [
    {
      // the database 'table'
      measurement: 'knx2',
      // we have INTEGER, FLOAT, STRING & BOOLEAN,
      fields: { value: Influx.FieldType.FLOAT },
      tags: ['location', 'event', 'source', 'groupaddr', 'name', 'type']
    }
  ]
})
// write to influxDB
function writeEvents(evt, src, dest, knxloc, name, type, value, unit) {
  if (evt != 'GroupValue_Write' && evt != 'GroupValue_Response') return;

  // define the event type - Write or Response
  var evtType = evt == 'GroupValue_Write' ? 'Write' : 'Response'

    // You cannot write fields of different types into the same measurement
    // within the same shard. If you do that, the points will be dropped.
    // - so convert to integer/float balsed on the current shard
    if (typeof(value) == "object") {
        if (type == "DPT_TimeOfDay") { // convert to julian
            //logger.info("DPT_TimeOfDay (%s) %s", type, value);
            return;
	}
	// for now we just assign it which means the write fails
        var dbvalue = value;
        //logger.info("Object value %s %s (%s) %s", src, dest, type, value);
    } else if (typeof(value) == "boolean") {
        //logger.info("Boolean value %s %s %s", src, dest, value);
	if (value == true)
	    var dbvalue = 1;
	else
	    var dbvalue = 0;
	//value = value == true ? 1 : 0;
        //logger.info("> Boolean value %j %s", dbvalue, typeof(dbvalue));
    } else { // assume "number"
         var dbvalue = value;
    }
    if (typeof(dbvalue) != "number") {
        logger.info("dbvalue %s %s %j %s", src, dest, dbvalue, typeof(dbvalue));
    }

    // need to add guard for no DPT definition - where type is undefined
    if (type == "" || typeof(type) == 'undefined') {
        //logger.info("Type is not defined (%s) %s", type, typeof(type));
        return;
    }


  // write to influxDB
  const date = new Date() // this is UTC
  influx
    .writePoints(
      [
        {
          measurement: 'knx2',
          tags: {
            location: knxloc,
            event: evtType,
            source: src,
            groupaddr: dest,
            name: name,
            type: type
          },
          fields: { value: dbvalue },
          timestamp: date
        }
      ],
      {
        database: 'hamon',
        precision: 'ms'
      }
    )
    .catch((error) => {
      logger.error(`Error saving data to InfluxDB! ${error.stack}`)
    })
}

module.exports.writeEvents = writeEvents
