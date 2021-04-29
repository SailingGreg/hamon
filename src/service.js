const fs = require('fs')
const { Worker } = require('worker_threads')
const yaml = require('js-yaml')
const logger = require('./logger')

const dnsSync = require('dns-sync')
var dnsEntry = "";
var lastworker = "";

async function runService(hamonConfig) {
  const doc = yaml.load(fs.readFileSync(hamonConfig, 'utf8'))
  for (location in doc.locations) {
    const loc = doc.locations[location]
    logger.info(`${loc.name} ${loc.dns} ${loc.port}`)
	  dnsEntry = loc.dns;
    new Promise((resolve, reject) => {
      const worker = new Worker('./src/connection.js', {
        workerData: { location: loc }
      })
	    if (loc.name == "office") {
	        lastworker = worker;
	    }
      worker.on('message', resolve)
      worker.on('error', reject)
      worker.on('exit', (code) => {
        if (code !== 0)
          reject(new Error(`Worker stopped with exit code ${code}`))
      })
    })
  }
    // do a syncDNS and then terminate
    const knxAddr = dnsSync.resolve(dnsEntry)
    console.log("dnsEntry %s", dnsEntry);
    lastworker.postMessage({ exit: true });
    console.log("terminated");
}

module.exports.runService = runService
