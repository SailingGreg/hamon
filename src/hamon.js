/*
 * hamon.js (index.js) the KNX Monitoring program
 *
 * Checks location and call services to parse and run
 *
 *
 */

const fs = require('fs')
const { runService } = require('./service')
const logger = require('./logger')

// location check - HOME
let home = process.env.HOME;
if (typeof home == 'undefined') {
    console.log ("HOME not defined: %s", home);
    return 1;
}
loc = home + "/hamon/";

const hamonConfig = loc + 'hamon.yml'

console.log("Working locations %s %s", __dirname, process.cwd());
if (fs.existsSync(hamonConfig)) {
  //file exists
  logger.info('Configuration file %s exists, parsing ...', hamonConfig)
  try {
    runService(loc, hamonConfig)
  } catch (e) {
    throw new Error(e)
  }
} else {
  logger.error("Configuration file %s doesn't exist", hamonConfig)
  return false
}
