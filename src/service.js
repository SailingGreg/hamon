/*
 * File: service.js - manage the worker threads for locations
 *
 *
 *
 */
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
    logger.info(`Starting: ${loc.name} ${loc.dns} ${loc.port} ${loc.device}`)
    loc["path"] = path; // add path
    //loc["device"] = device;
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

let last_time = 0;
let d = new Date().getTime();

// main entry
async function runService(path, hamonConfig) {
  fs.watch(hamonConfig, function (event, filename) {
      /*
       * put a guard in here so resets only if not called with the last
       * 10 seconds?
       */
        d = new Date().getTime(); // refresh time
        logger.info("runTime %d", d, last_time);
        if (d > (last_time + (20 * 1000))) {
            logger.info("Restarting .... %d", (d - last_time));
        
            let rs = ConnectionService(path, getDoc(hamonConfig));
       
            last_time = d; // note time
       
            return rs;
        }
    //return ConnectionService(path, getDoc(hamonConfig))
  })

  if (firstRun) {
    firstRun = false
    return ConnectionService(path, getDoc(hamonConfig))
  }
}

module.exports.runService = runService
