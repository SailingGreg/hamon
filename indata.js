/*
 * test program to write to influxDB
 *
 */


const Influx = require('influx');

// table knx with source, groupaddress and value
const influx = new Influx.InfluxDB({
  host: 'localhost',
  database: 'hamon',
  username: 'grafana',
  password: 'Grafana',
  schema: [
    {
      measurement: 'knx',
      // we have INTEGER, FLOAT, STRING & BOOLEAN,
      fields: { groupaddr: Influx.FieldType.STRING,
		source: Influx.FieldType.STRING },
		value: Influx.FieldType.FLOAT },
      tags: ['unit', 'location']
    }
  ]
})

