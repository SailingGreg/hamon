const fs = require('fs')
const { Worker } = require('worker_threads')
const yaml = require('js-yaml')
const logger = require('./logger')
const dnsSync = require('dns-sync')

let firstRun = true
var dnsEntry = ''
const threads = new Set()
let workerLocations = new Map()

const getDoc = (hamonConfig) => yaml.load(fs.readFileSync(hamonConfig, 'utf8'))

async function ConnectionService(doc) {
  for (location in doc.locations) {
    const loc = doc.locations[location]
    logger.info(`${loc.name} ${loc.dns} ${loc.port}`)
    dnsEntry = loc.dns
    const worker = new Worker('./src/connection.js', {
      workerData: { location: loc }
    })
    workerLocations.set(loc.name, worker)
    threads.add(worker)
  }
  for (let worker of threads) {
    worker.on('error', (err) => {
      throw err
    })
    worker.on('exit', () => {
      threads.delete(worker)
      console.log(`Thread exiting, ${threads.size} running...`)
    })
  }
  // do a syncDNS and then terminate
  const knxAddr = dnsSync.resolve(dnsEntry)
  console.log('knxAddr', knxAddr)
  const workersIterator = threads.values()
  const worker = workersIterator.next().value
  console.log('dnsEntry %s', dnsEntry)
  worker.postMessage({ exit: true })
}

async function runService(hamonConfig) {
  fs.watch(hamonConfig, function (event, filename) {
    return ConnectionService(getDoc(hamonConfig))
  })

  if (firstRun) {
    firstRun = false
    return ConnectionService(getDoc(hamonConfig))
  }
}

module.exports.runService = runService
