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

// Wind orientation (DPT_String_ASCII) arrives as a compass label rather than
// a number; map it to bearing degrees so it can be stored in the float `value`
// field. Keys are lower-cased; note the device emits the typo "Nort-Easterly".
const WIND_DIR_DEG = {
  "northerly": 0,
  "nort-easterly": 45, "north-easterly": 45,
  "easterly": 90,
  "south-easterly": 135,
  "southerly": 180,
  "south-westerly": 225,
  "westerly": 270,
  "north-westerly": 315
}

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
        // convert to julian at some future point
        if (type == "DPT_TimeOfDay" || type == "DPT_Date") {
            //logger.info("DPT_TimeOfDay (%s) %s", type, value);
            return;
	}
	// composite/object DPTs (e.g. DPT_SceneControl) are not yet expanded
	// into numeric points - leave dbvalue as the object so the guard below
	// skips it rather than writing "[object Object]" which InfluxDB rejects
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
    } else if (typeof(value) == "string") {
        // KNX payloads are predominantly numeric but some arrive as strings.
        // Strip DPT16 null padding, then coerce to a number so they land in
        // the float `value` field instead of being dropped on a type conflict.
        const s = value.replace(/\u0000/g, "").trim();
        const n = s === "" ? NaN : Number(s);
        if (Number.isFinite(n)) {
            dbvalue = n;
        } else {
            // not a plain number - try the wind-direction map (Westerly -> 270);
            // anything still non-numeric stays a string and is skipped below
            const deg = WIND_DIR_DEG[s.toLowerCase()];
            dbvalue = deg !== undefined ? deg : value;
        }
    } else { // assume "number"
         dbvalue = value;
    }
    // final guard: only finite numbers can go to the float `value` field;
    // anything else (unconverted strings, objects, NaN) would be rejected by
    // InfluxDB, so skip the write rather than emit a 422
    if (typeof(dbvalue) != "number" || !Number.isFinite(dbvalue)) {
        //logger.info("dbvalue %s %s %j %s", src, dest, dbvalue, typeof(dbvalue));
        return;
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

  // NB: the comma between the write options and the points array is load-bearing.
  // Without it `{...}[ {...} ]` parses as a property access and write() is called
  // with undefined - the actions were silently never written.
  influxdb.write(
      {
            org: "HA",
            //precision: 'ms',
            bucket: process.env.BUCKET
      },
      [ {
          measurement: 'actions',
          tags: {
            location: knxloc, // locations
            event: evt, // read or write in this case
            groupaddr: dest // targeted gad
          },
          fields: { value: avalue }
        } ]
    )
    .catch((error) => {
      logger.error(`Error saving data to InfluxDB actions! ${error.stack}`)
    })
}

// changed to exports as there is more than one function
exports.writeEventsv2 = writeEventsv2
exports.writeActionsv2 = writeActionsv2
