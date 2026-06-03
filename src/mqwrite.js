const mqtt = require('mqtt') // added to package.jso
const logger = require('./logger')
const { writeActions } = require('./db')
const { writeActionsv2 } = require('./dbv2')

const MQTTBROKERIP = 'mqtt://localhost' // needs protocol which is mqtt
//const MQTTBROKERPORT = 1883 // default
const topicPrefix = '' || 'knx'
const gadRegExp = new RegExp(
  topicPrefix + '/(\\w+)/(\\d+)/(\\d+)/(\\d+)(/([\\w\\d]+))?'
)

// Convert the raw MQTT string payload into the JS type the group address's DPT
// expects, so knx Datapoint.write() encodes it correctly. Replaces the old
// unconditional parseInt(), which turned floats (21.5 -> 21), strings and
// booleans (e.g. "On" -> NaN) into bad values and broke the write.
function coerceForDpt (dpt, raw) {
  const s = String(raw).trim()
  if (s.length === 0) return 0
  const major = String(dpt || '').split('.')[0]
  switch (major) {
    case 'DPT1':            // boolean: switch / bool / enable ...
      return /^(1|on|true|yes|enable)$/i.test(s)
    case 'DPT9':            // 2-byte float (temperature, humidity, ...)
    case 'DPT14':           // 4-byte float
      return parseFloat(s)
    case 'DPT16':           // character string
      return s
    case '':                // DPT unknown - best effort: number if numeric else string
      return isNaN(Number(s)) ? s : Number(s)
    default:                // integer DPTs: DPT5/6/7/8/12/13 (scaling, counts, ...)
      return parseInt(s, 10)
  }
}

let mqttClient = null; // rescope so available to disconnect
function MQTTconnect(groupAddresses, connection, location) {
  //let mqttClient = mqtt.connect(MQTTBROKERIP)
  mqttClient = mqtt.connect(MQTTBROKERIP)

    mqttClient.on('connect', function () {
    console.log(`MQTT connected to ${location?.name}`)
    mqttClient.subscribe(`${topicPrefix}/${location.name}/+/+/+`)
    mqttClient.subscribe(`${topicPrefix}/${location.name}/+/+/+/+`)
  })

  mqttClient.on('message', function (topic, message) {
    let msg = message.toString('utf8')

    logger.info(`MQTT Topic: ${topic}, message: <${msg}>`)

    if (topic.startsWith('knx')) {
      let gadArray = gadRegExp.exec(topic)
      if (!gadArray) return
 
      let gad = gadArray[2] + '/' + gadArray[3] + '/' + gadArray[4]
      let cmd = gadArray[6]

      if (groupAddresses.hasOwnProperty(gad)) {

        // convert the raw payload to the JS type this GAD's DPT expects
        let value = coerceForDpt(groupAddresses[gad].dpt, msg)

        // log the action - loc, type, target and 'value'. Keep the influx
        // 'actions.value' field numeric (booleans -> 1/0) so a DPT1 write
        // doesn't flip the field type and get dropped on a type conflict.
        let logValue = typeof value === 'boolean' ? (value ? 1 : 0) : value
        // route to the same InfluxDB version as the events path (connection.js):
        // influxver == 1 -> v1 (db.js), otherwise v2 (dbv2.js). All instances are
        // now v2; db.js is kept as the feature-flagged v1 fallback.
        if (location?.influxver == 1) {
          writeActions(location.name, cmd, gad, logValue);
        } else {
          writeActionsv2(location.name, cmd, gad, logValue);
        }

        if (cmd == 'write') {
          if (typeof value === 'number' && Number.isNaN(value)) {
            logger.error(
              'Ignoring write to %s: payload %j invalid for dpt %s',
              gad,
              msg,
              groupAddresses[gad].dpt
            )
          } else {
            try {
              // ref endpoint
              groupAddresses[gad].endpoint.write(value)
            } catch (err) {
              logger.error(
                'Could not write message %j to group address %s, err: %s',
                err.message,
                gad,
                err
              )
            }
          }
        } else if (cmd == 'read') {
            //console.log(`read topic: ${topic}, message: ${msg}`)
            groupAddresses[gad].endpoint.read()
            //connection.read(gad);
        } else if (cmd == 'on') {
          //check if on is okay and then action
          // if (type == DPT_Switch )
          groupAddresses[gad].endpoint.switchOn()
        } else if (cmd == 'off') {
          //check if off is okay and then action
          // if (type == DPT_Switch )
          groupAddresses[gad].endpoint.switchOff()
        } else {
          logger.info('Invalid command %s', cmd)
        }
      }
    }
  })


}

// added to do the tidyup - note used end() and not the more common disconnect
function mqdisconnect () {
    //console.log("calling mqtt disconnect");
    if (mqttClient != null) // check it is connected!
        mqttClient.end();
    //mqttClient.disconnect();
}

//module.exports.MQTTconnect = MQTTconnect
exports.MQTTconnect = MQTTconnect
exports.mqdisconnect = mqdisconnect
exports.coerceForDpt = coerceForDpt
