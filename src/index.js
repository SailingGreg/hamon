const fs = require('fs')
const { runService } = require('./service')
const logger = require('./logger')

const hamonConfig = 'hamon.yml'

if (fs.existsSync('./' + hamonConfig)) {
  //file exists
  logger.info('Configuration file %s exists, parsing ...', hamonConfig)
  try {
    runService(hamonConfig)
  } catch (e) {
    throw new Error(e)
  }
} else {
  logger.error("Configuration file %s doesn't exist", hamonConfig)
  return false
}
