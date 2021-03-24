/*
 Program to list the themostat which updates every 15 mins

 It create a new datapoint and then sets a '.on' for updates

*/

// load knx ip stack
var knx = require('knx');

// and create connection
var connection = knx.Connection({

 // the following is the ip address for ha-test.dyndns.org
 //ipAddr: '92.15.30.220', ipPort: 50001,
 ipAddr: '92.19.140.228', ipPort: 50001,
 // may be incorrect
 //physAddr: '0.1.0',
 // ensure it tunneling and not operating n hybrid mode
 forceTunneling: true,
 // the defaut is info
 //loglevel: 'debug',
 handlers: {
  connected: function() {
    console.log('Connected!');

    // read temp
    // this is temp on 1.1.14
    var tdpga = '0/1/0'; // the ga address for thermostat
    var tdptype = 'DPT9.001'; // and the type

    var dp = new knx.Datapoint({ga: tdpga, dpt: 'DPT9.001'}, connection);
    //var dp = new knx.Datapoint({ga: '0/1/0', dpt: 'DPT9.001'}, connection);
    //var dp = new knx.Datapoint({ga: '0/1/0', dpt: 'DPT9.001, autoread: true});

    // signature is mapped
    //dp.on('event', function(evt, src, dst, value) {
    dp.on('event', function(evt, value) {
                   //onKnxEvent(evt, key, value, groupAddresses[key]);
       // need to check the evt type - is it Write!
       console.log("**** %j %j reports current value: %j",  tdpga, evt, value);
    });

    console.log('Read temp');
    dp.read( function (response) {
        console.log("KNX %j response: %j", response);
    });

    dp.read((src, value) => {
       console.log("**** RESPONSE %j reports current value: %j", src, value);
    });

    //connection.read("0/1/0", (src, value) => { 
      //console.log("**** RESPONSE %j reports current value: %j", src, value);
    // });
  },
  event: function (evt, src, dest, value) {
   console.log("%s **** KNX EVENT: %j, src: %j, dest: %j, value: %j",
    new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
    evt, src, dest, value);
  },
  error: function(connstatus) {
      console.log("**** ERROR: %j", connstatus);
  }
  //dp.on('change', function(oldvalue, newvalue) {
       //console.log("**** DP reports current values: %j %j", oldvalue, newvalue);
  //});
 }
});
