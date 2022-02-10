/*
 Simple script to test knx.js and validate connectivity
 It will list all events exposed on the bus via the KNXnet/IP router
*/
const { workerData } = require('worker_threads')
const logger = require('./src/logger');

// load knx ip stack
var knx = require('knx')
var dnsSync = require('dns-sync')

const { knxnetIP, knxnetPort, name } = workerData

// resolve the KNXnet/IP router
knxnetAddr = dnsSync.resolve(knxnetIP)

// and create connection
var connection = knx.Connection({
  // the following is the ip address for ha-test.dyndns.org
  // as the module needs ipv4/ipv6 address
  ipAddr: knxnetAddr,
  ipPort: knxnetPort,
  // may be incorrect
  // physAddr: '0.1.0',
  // ensure it tunneling and not operating n hybrid mode
  forceTunneling: true,
  // the default is info
  // logLevel: 'debug',
  handlers: {
    connected: function () {
      logger.info('Connected!')
    },
    event: function (evt, src, dest, value) {
      logger.info(
        '%s **** KNX EVENT: %j, src: %j, dest: %j, value: %j, name: %j',
        new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
        evt,
        src,
        dest,
        value, 
        name
      )
    },
    error: function (connstatus) {
      logger.error('**** ERROR: %j', connstatus)
    }
  }
})
