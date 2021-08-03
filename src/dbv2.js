/*
 * File: db.js - database writes
 *
 * code checks for type to ensure only 'numbers' are written to the
 * default shard otherwise InfluxDB will ignore the write
 *
 * Also check for undefined type where the DPT is not defined as this
 * results in an error as the tag is not defined on the write
 */

const Influxdb = require('influxdb-v2')
const logger = require('./logger')
const dotenv = require('dotenv')

const result = dotenv.config({ path: __dirname + '/.env' });
if (result.error) {
    throw result.error;
}

// influxDB connection
const influxdb = new Influxdb({
  host: 'localhost',
  protocol: 'http', // added to stop defaulting to https
  port: 8086, // and port 443!
  token: process.env.TOKENPROD
  /*
  schema: [
    {
      // the database 'table'
      measurement: 'knx2',
      // we have INTEGER, FLOAT, STRING & BOOLEAN,
      fields: { value: Influx.FieldType.FLOAT },
      tags: ['location', 'event', 'source', 'groupaddr', 'name', 'type']
    }
  ]
  */
})

// write to influxDB
function writeEventsv2(evt, src, dest, knxloc, name, type, value, unit) {
  if (evt != 'GroupValue_Write' && evt != 'GroupValue_Response') return;

    let dbvalue = 0.0;

  // define the event type - Write or Response
  var evtType = evt == 'GroupValue_Write' ? 'Write' : 'Response'

    // You cannot write fields of different types into the same measurement
    // within the same shard. If you do that, the points will be dropped.
    // - so convert to integer/float so consisten with the current shard
    if (typeof(value) == "object") {
        if (type == "DPT_TimeOfDay") { // convert to julian
            //logger.info("DPT_TimeOfDay (%s) %s", type, value);
            return;
	}
	// for now we just assign it which means the write fails
        dbvalue = value;
        //logger.info("Object value %s %s (%s) %s", src, dest, type, value);
    } else if (typeof(value) == "boolean") {
        //logger.info("Boolean value %s %s %s", src, dest, value);
	if (value == true)
            dbvalue = 1;
	else
            dbvalue = 0;
	//value = value == true ? 1 : 0;
        //logger.info("> Boolean value %j %s", dbvalue, typeof(dbvalue));
    } else { // assume "number"
         dbvalue = value;
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
  influxdb.write(
        {
            org: "HA",
            //precision: 'ms'
            bucket: process.env.BUCKET
        },
      [ {
          measurement: 'knx2',
          tags: {
            location: knxloc,
            event: evtType,
            source: src,
            groupaddr: dest,
            name: name,
            type: type
          },
          fields: { value: dbvalue } //,
          //timestamp: date
        } ]
      /*,
      {
        database: 'hamon',
        precision: 'ms'
      }
      */
    )
    .catch((error) => {
      logger.error(`Error saving data to InfluxDB! ${error.stack}`)
    })
}


/*
// for actions
const influx2 = new Influx.InfluxDB({
  host: 'localhost',
  database: process.env.DATABASE,
  username: process.env.USERNAME,
  password: process.env.PASSWORD,
  schema: [
    {
      // the database 'table'
      measurement: 'actions',
      // we have INTEGER, FLOAT, STRING & BOOLEAN,
      fields: { value: Influx.FieldType.FLOAT },
      tags: ['location', 'event', 'groupaddr']
    }
  ]
})
*/

// write for actions
function writeActionsv2(knxloc, evt, dest, avalue) {

  const date = new Date() // this is UTC
  influxdb.write(
      {
            org: "HA",
            //precision: 'ms',
            bucket: process.env.BUCKET
            //database: 'hamon',
      }
      [ {
          measurement: 'actions',
          tags: {
            location: knxloc, // locations
            event: evt, // read or write in this case
            groupaddr: dest // targeted gad
          },
          fields: { value: avalue },
          timestamp: date
        } ]
    )
    .catch((error) => {
      logger.error(`Error saving data to InfluxDB actions! ${error.stack}`)
    })
}

// changed to exports as there is more than one function
exports.writeEventsv2 = writeEventsv2
exports.writeActionsv2 = writeActionsv2
