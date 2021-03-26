/*
 * test program to write to influxDB
 *
 * this just defines a simple data series with a couple of tags
 */

const Influx = require('influx');

// add nano date support for influxdb
//import { toNanoDate } from 'influx'


// table knx with source, groupaddress and value
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

const date = new Date();

influx.writePoints([
      {
        measurement: 'knx',
        tags: {
          groupaddr: "0/1/0",
          source: "1.1.14",
        },
        fields: { value: 20.12 },
        timestamp: date,
        //timestamp: date.toISOString(),
      }
    ], {
      database: 'hamon',
      precision: 'ms',
    })
    .catch(error => {
      console.error(`Error saving data to InfluxDB! ${error.stack}`)
    });
