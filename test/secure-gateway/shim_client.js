// shim_client.js - drive hamon's knxultimate shim against the simulator over secure tunnelling
//   node shim_client.js <config.json> [seconds] [port] [user]
// prints each group telegram the shim delivers (Data Secure ones decrypted with the config's keys)
'use strict'
const path = require('path')
const SRC = path.resolve(__dirname, '../../src')
const cfg = require(path.resolve(process.argv[2]))
const seconds = Number(process.argv[3] || 8)
const port = Number(process.argv[4] || cfg.port || 3671)
const user = process.argv[5] || '2'
const logger = require(SRC + '/logger')
for (const lvl of ['info', 'warn', 'error']) {
  logger[lvl] = (...a) => console.log(`  shim ${lvl}: ` + require('util').format(...a))
}
const { Connection } = require(SRC + '/ultimate-shim')
let n = 0
const conn = Connection({
  ipAddr: cfg.listen || '127.0.0.1', ipPort: port, loglevel: 'error',
  secure: { tunnelIA: cfg.users[user].tunnel, userId: Number(user), password: cfg.users[user].password,
            deviceAuthCode: cfg.device_authentication_code, groupKeys: cfg.group_keys || {} },
  handlers: {
    connected: () => console.log('  CONNECTED'),
    event: (evt, src, dest, value) => { n++; console.log(`  rx ${evt} ${src} -> ${dest} ${Buffer.isBuffer(value) ? value.toString('hex') : value}`) },
    error: (e) => console.log('  ERROR', e),
  },
})
conn.on('error', (e) => console.log('  error event:', e))
setTimeout(() => { console.log(`received ${n} telegrams`); try { conn.Disconnect() } catch (e) {} ; setTimeout(() => process.exit(0), 1500) }, seconds * 1000)
