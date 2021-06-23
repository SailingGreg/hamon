const mqtt = require('mqtt') // added to package.jso
const logger = require('./logger')
const { writeActions } = require('./db')

const MQTTBROKERIP = 'mqtt://localhost' // needs protocol which is mqtt
//const MQTTBROKERPORT = 1883 // default
const topicPrefix = '' || 'knx'
const gadRegExp = new RegExp(
  topicPrefix + '/(\\w+)/(\\d+)/(\\d+)/(\\d+)(/([\\w\\d]+))?'
)

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
    // ensure value in shard is consistent and decimal
    if (typeof msg === 'string')
        if (msg.length == 0)
            msg = 0
        else
            msg = parseInt(msg)

    if (topic.startsWith('knx')) {
      let gadArray = gadRegExp.exec(topic)
      if (!gadArray) return
 
      let gad = gadArray[2] + '/' + gadArray[3] + '/' + gadArray[4]
      let cmd = gadArray[6]

      if (groupAddresses.hasOwnProperty(gad)) {

        // log the actions - loc, type, target and 'value'
        writeActions(location.name, cmd, gad, msg);

        if (cmd == 'write') {
          // check value?
          try {
            // ref endpoint
            groupAddresses[gad].endpoint.write(msg)
          } catch (err) {
            logger.error(
              'Could not write message %j to group address %s, err: %s',
              err.message,
              gad,
              err
            )
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
