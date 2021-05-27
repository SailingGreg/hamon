/*
 * File: mqread.js - connects to mq and listens for any events
 *
 *
 */

const mqtt = require('mqtt'); // added to package.json
const ets = require('./parsexml')
const MQTTBROKERIP = "mqtt://localhost"; // needs protocol which is mqtt
const MQTTBROKERPORT = 1883; // default
const MQTTUSERNAME = "";
const MQTTPASSWORD = "";
const { writeEvents } = require('./src/db')
const yaml = require('js-yaml')
const fs = require('fs')
const logger = require('./src/logger')
const topicPrefix = ""; // blank for now
// need to add 'location' to following for the thread
const gadRegExp = new RegExp((topicPrefix || 'knx/') + '(\\w+)/(\\d+)\/(\\d+)\/(\\d+)\/(\\w+)');
let mqttClient  = mqtt.connect(MQTTBROKERIP);

const getDoc = (hamonConfig) => yaml.load(fs.readFileSync(hamonConfig, 'utf8'));
/*
 * We can use a "knx/{location}/+/+/+/+" format 
 */
mqttClient.on('connect', function () {
    console.log('MQTT connected');
    // this should be something line knx/{location}/+/+/+
    // and knx/{location}/+/+/+/+ for command
    mqttClient.subscribe(topicPrefix + '#'); // that is everything
});

mqttClient.on('message', function (topic, message) {

    // this should print something as 'persist' is used on send
    let msg = message.toString('utf8');
    console.log("topic: %s message: %j", topic, msg);

    // need to parse the topic - does it have read/write?
    if (topic.startsWith("knx")) { // guard
        console.log("topic", topic)
      //  extract group address
       let gadArray = gadRegExp.exec(topic);
  
       if(!gadArray) return
        let location = gadArray[1]
        let dest = gadArray[2] + "/" + gadArray[3] + "/" + gadArray[4];
        let cmd = gadArray[5];
        const rest = (gadArray.input.replace(gadArray[0]+"/", "")).split('/')
        console.log("> address/command: %s %s", location, dest, cmd);
        const path = "/home/e2h3/Dev/hamon/"
        const hamonConfig = getDoc(path + 'hamon.yml')
        let config;
        for ( let locale in hamonConfig.locations ) {
            if (hamonConfig.locations[locale].name === location) {
                config = hamonConfig.locations[locale].config
            }
        }
        const groupAddresses = ets.parsexml(path + config) || {}
        if (groupAddresses.hasOwnProperty(dest)) {
            ctime = localDate().replace(/T/, ' ').replace(/\..+/, '')
            const evt = "GroupValue_Write"
            console.log('ctime', ctime)
            console.log('dest', groupAddresses[dest])
            const src = rest[0]
            logger.info(
              '>> %s Event %s %j -> %j (%s - %s) - %j %s %j',
              ctime,
              evt,
              src,
              dest,
              groupAddresses[dest].name,
              rest[1],
              msg,
              "unit",
              typeof(msg)
            )
            // encode the evt to shorten it - "gw" or "re"
            // if (groupAddresses[dest].type != undefined 
            //         && groupAddresses[dest].type != '') { // if type
                writeEvents(
                    evt,
                    src,
                    dest,
                    location,
                    groupAddresses[dest].name,
                    rest[1],
                    msg,
                )
            // }
          }
        // is the group address valid & a write??
        /*
        if (groupAddresses.hasOwnProperty(gad)) {
            if (cmd == 'write') {
                // check value?
                try {
                    // ref endpoint
                    groupAddresses[gad].endpoint.write(msg);
                } catch (err) {
                    logger.error('Could not write message %j to group address %s, err: %s', parsedMessage, gad, err);
            }} else if (cmd == 'read') { // read
                    groupAddresses[gad].endpoint.read();
            } else if (cmd == 'on') {
                //check if on is okay and then action
                // if (type == DPT_Switch ) 
                groupAddresses[gad].endpoint.switchOn();
            } else if (cmd == 'off') {
                //check if off is okay and then action
                // if (type == DPT_Switch ) 
                groupAddresses[gad].endpoint.switchOff();
            } else {
                logger.info("Invalid command %s", cmd);
            }
        }
    }
       */ 
    }

   // client.end()
})


function localDate() {
    var date = new Date()
    var isoDateTime = new Date(
      date.getTime() - date.getTimezoneOffset() * 60000
    ).toISOString()
    return isoDateTime
  }