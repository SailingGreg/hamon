/*
 * File: mqread.js - connects to mq and listens for any events
 *
 *
 */

const mqtt = require('mqtt'); // added to package.json

const MQTTBROKERIP = "mqtt://localhost"; // needs protocol which is mqtt
const MQTTBROKERPORT = 1883; // default
const MQTTUSERNAME = "";
const MQTTPASSWORD = "";

const topicPrefix = ""; // blank for now
// need to add 'location' to following for the thread
const gadRegExp = new RegExp((topicPrefix || 'knx/') + '(\\d+)\/(\\d+)\/(\\d+)\/(\\w+)(\/([\\w\\d]+))?');

let mqttClient  = mqtt.connect(MQTTBROKERIP);

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

        // extract group address
        let gadArray = gadRegExp.exec(topic);
        let gad = gadArray[1] + "/" + gadArray[2] + "/" + gadArray[3];
        let cmd = gadArray[4];
        console.log("> address/command: %s %s", gad, gadArray[4]);

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
            } else { // read
                    groupAddresses[gad].endpoint.read();
            }
        }
        */
    }

    // client.end()
})
