const mqtt = require('mqtt') // added to package.jso
const logger = require('./logger')
const { writeActions } = require('./db')
const { writeActionsv2 } = require('./dbv2')
const { parsePayload } = require('./payload')
const { writeError } = require('./dptrange')
const { dptMain } = require('./dptnames')

const MQTTBROKERIP = 'mqtt://localhost' // needs protocol which is mqtt
//const MQTTBROKERPORT = 1883 // default
const topicPrefix = '' || 'knx'
const gadRegExp = new RegExp(
  topicPrefix + '/(\\w+)/(\\d+)/(\\d+)/(\\d+)(/([\\w\\d]+))?'
)

// one client per site, returned to the caller (site.js), which passes it to
// mqdisconnect() - sites may share this module in one thread, so it logs
// through the site's logger (log)
function MQTTconnect(groupAddresses, connection, location, log = logger.siteLogger(location?.name)) {
  const mqttClient = mqtt.connect(MQTTBROKERIP)

    mqttClient.on('connect', function () {
    log.info(`MQTT connected to ${location?.name}`)
    mqttClient.subscribe(`${topicPrefix}/${location.name}/+/+/+`)
    mqttClient.subscribe(`${topicPrefix}/${location.name}/+/+/+/+`)
  })

  mqttClient.on('message', function (topic, message) {
    let msg = message.toString('utf8')

    log.info(`MQTT Topic: ${topic}, message: <${msg}>`)

    if (topic.startsWith('knx')) {
      let gadArray = gadRegExp.exec(topic)
      if (!gadArray) return
 
      let gad = gadArray[2] + '/' + gadArray[3] + '/' + gadArray[4]
      let cmd = gadArray[6]

      if (groupAddresses.hasOwnProperty(gad)) {

        // parse the payload into the value this GAD's DPT expects
        let value = parsePayload(groupAddresses[gad].dpt, msg)

        // log the action - loc, type, target and 'value'. The influx
        // 'actions.value' field is a float, so only numbers go in (booleans and
        // on/off -> 1/0, a read -> 0); a refused, text or object write is not
        // logged there (its MQTT Topic line above still is)
        let logValue
        if (cmd == 'read') logValue = 0
        else if (cmd == 'on' || cmd == 'off') logValue = cmd == 'on' ? 1 : 0
        else if (typeof value === 'boolean') logValue = value ? 1 : 0
        else if (typeof value === 'number' && Number.isFinite(value)) logValue = value
        // route to the same InfluxDB version as the events path (connection.js):
        // influxver == 1 -> v1 (db.js), otherwise v2 (dbv2.js). All instances are
        // now v2; db.js is kept as the feature-flagged v1 fallback.
        if (logValue === undefined) {
          // nothing numeric to log
        } else if (location?.influxver == 1) {
          writeActions(location.name, cmd, gad, logValue);
        } else {
          writeActionsv2(location.name, cmd, gad, logValue);
        }

        if (cmd == 'write') {
          if (typeof value === 'number' && Number.isNaN(value)) {
            log.error(
              'Ignoring write to %s: payload %j invalid for dpt %s',
              gad,
              msg,
              groupAddresses[gad].dpt
            )
          } else if (writeError(groupAddresses[gad].dpt, value)) {
            // checked here as both KNX libraries would send some of these as a
            // different value rather than refuse them
            log.error('Ignoring write to %s: %s', gad, writeError(groupAddresses[gad].dpt, value))
          } else {
            try {
              // ref endpoint
              groupAddresses[gad].endpoint.write(value)
            } catch (err) {
              log.error(
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
        } else if (cmd == 'on' || cmd == 'off') {
          // a Datapoint has no switchOn()/switchOff() (that's knx's
          // BinarySwitch), so calling them threw outside any try. Write the
          // boolean: knx 2.4.1 inverts a numeric 1/0 for DPT1
          try {
            if (dptMain(groupAddresses[gad].dpt) !== 1) throw new Error(`not a DPT1 GA (${groupAddresses[gad].dpt})`)
            groupAddresses[gad].endpoint.write(cmd == 'on')
          } catch (err) {
            log.error('Could not %s group address %s, err: %s', cmd, gad, err)
          }
        } else {
          log.info('Invalid command %s', cmd)
        }
      }
    }
  })

  return mqttClient
}

// added to do the tidyup - note used end() and not the more common disconnect
function mqdisconnect (mqttClient) {
    if (mqttClient != null) // check it is connected!
        mqttClient.end();
}

//module.exports.MQTTconnect = MQTTconnect
exports.MQTTconnect = MQTTconnect
exports.mqdisconnect = mqdisconnect
exports.parsePayload = parsePayload
