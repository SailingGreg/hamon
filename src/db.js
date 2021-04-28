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
function writeEvents(evt, src, dest, knxloc, name, type, value) {
  if (evt != 'GroupValue_Write' && evt != 'GroupValue_Response') return
  // define the event type - Write or Response
  var evtType = evt == 'GroupValue_Write' ? 'Write' : 'Response'
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
          fields: { value: value },
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
