/*
 * File: db.js - database writes
 *
 *
 *
 *
 */

const Influx = require('influx')
const logger = require('./logger')

// influxDB connection
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
        logger.info("Boolean value %s %s %s", src, dest, value);
	if (value == true)
	    var dbvalue = 1;
	else
	    var dbvalue = 0;
	//value = value == true ? 1 : 0;
        logger.info("> Boolean value %j %s", dbvalue, typeof(dbvalue));
    } else { // assume "number"
         var dbvalue = value;
    }
    if (typeof(dbvalue) != "number") {
        logger.info("dbvalue %s %s %j %s", src, dest, dbvalue, typeof(dbvalue));
	//value = value == true ? 1 : 0;
    }

  // need to add guard for no DPT definition - where type is undefined

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
