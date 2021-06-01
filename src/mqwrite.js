const mqtt = require('mqtt') // added to package.jso
const logger = require('./logger')

const MQTTBROKERIP = 'mqtt://localhost' // needs protocol which is mqtt
const MQTTBROKERPORT = 1883 // default
const topicPrefix = '' || 'knx'
const gadRegExp = new RegExp(
  topicPrefix + '/(\\w+)/(\\d+)/(\\d+)/(\\d+)(/([\\w\\d]+))?'
)

function MQTTconnect(groupAddresses, connection, location) {
  let mqttClient = mqtt.connect(MQTTBROKERIP)

    mqttClient.on('connect', function () {
    console.log(`MQTT connected to ${location?.name}`)
    mqttClient.subscribe(`${topicPrefix}/${location.name}/+/+/+`)
    mqttClient.subscribe(`${topicPrefix}/${location.name}/+/+/+/+`)
  })

  mqttClient.on('message', function (topic, message) {
    let msg = message.toString('utf8')

    // ensure value in shard consistent
    if ((typeof msg === 'string') && (msg.lenght == 0)) msg = 0;

    console.log(`Topic: ${topic}, message: ${msg}`)
    if (topic.startsWith('knx')) {
      let gadArray = gadRegExp.exec(topic)
      if (!gadArray) return
 
      let gad = gadArray[2] + '/' + gadArray[3] + '/' + gadArray[4]
      let cmd = gadArray[6]

      if (groupAddresses.hasOwnProperty(gad)) {

        // log the actions - loc, type, target and 'value'
        //console.log(`logging: ${msg}`)
        //writeActions(location.name, cmd, gad, msg);
        //console.log(`Logged ${msg}`)

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
          // read
            console.log(`read topic: ${topic}, message: ${msg}`)
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

module.exports.MQTTconnect = MQTTconnect
