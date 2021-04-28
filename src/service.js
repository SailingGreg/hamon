const fs = require('fs')
const { Worker } = require('worker_threads')
const yaml = require('js-yaml')
const logger = require('./logger')

async function runService(hamonConfig) {
  const doc = yaml.load(fs.readFileSync(hamonConfig, 'utf8'))
  for (location in doc.locations) {
    const loc = doc.locations[location]
    logger.info(`${loc.name} ${loc.dns} ${loc.port}`)
    new Promise((resolve, reject) => {
      const worker = new Worker('./src/connection.js', {
        workerData: { location: loc }
      })
      worker.on('message', resolve)
      worker.on('error', reject)
      worker.on('exit', (code) => {
        if (code !== 0)
          reject(new Error(`Worker stopped with exit code ${code}`))
      })
    })
  }
}

module.exports.runService = runService
