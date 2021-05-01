const fs = require('fs')
const { Worker } = require('worker_threads')
const yaml = require('js-yaml')
const logger = require('./logger')
const dnsSync = require('dns-sync')

let firstRun = true
//var dnsEntry = ''
const threads = new Set()

const getDoc = (hamonConfig) => yaml.load(fs.readFileSync(hamonConfig, 'utf8'));

async function ConnectionService(path, doc) {
  // delete existing workers
  for (let worker of threads) {
    worker.terminate()
  }
  threads.clear()

	//console.log("service.js %s", path);
  for (location in doc.locations) {
    const loc = doc.locations[location]
    logger.info(`Starting: ${loc.name} ${loc.dns} ${loc.port}`)
    loc["path"] = path; // add path
    const worker = new Worker(path + './src/connection.js', {
      workerData: { location: loc }
    })
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
  /*
  const knxAddr = dnsSync.resolve(dnsEntry)
  console.log('knxAddr', knxAddr)
  const workersIterator = threads.values()
  const worker = workersIterator.next().value
  console.log('dnsEntry %s', dnsEntry)
  worker.postMessage({ exit: true })
  */
}

// main entry
async function runService(path, hamonConfig) {
  fs.watch(hamonConfig, function (event, filename) {
    return ConnectionService(path, getDoc(hamonConfig))
  })

  if (firstRun) {
    firstRun = false
    return ConnectionService(path, getDoc(hamonConfig))
  }
}

module.exports.runService = runService
