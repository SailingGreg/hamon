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

let sigcnt = 0;
// deal with signals and exit gracefully
function sigHandler(signal) {
    ttype = typeof signal;
    console.log(`Caught interrupt ${signal} ${ttype}`);

    // following is basically redundant with the addition of setTimeout()
    sigcnt++;
    if (sigcnt > 1) // use this to ensure abort
        process.exit(1);

    // signal threads to exit
    for (let worker of threads) {
        //console.log("exiting threads");
        worker.postMessage({ exit: true });
    }

    // guard as we need to wait for threads to exit
    if (threads.size > 0) {
        // and we set a timer in case systemd only does a SIGTERM
        let timeout = 450 * threads.size; // 450msec per worker
        console.log(`Threads outstanding ${threads.size}, setting timeout`)
        setTimeout (() => {
            console.log(`Timeout and exiting`)
            process.exit()
        }, timeout);
    } else {
        console.log(`Exiting`)
        process.exit();
    }
}

// handle CTRL-C, SIGTERM and SIGHUP from systemd
process.on('SIGINT', sigHandler);
process.on('SIGTERM', sigHandler);
process.on('SIGHUP', sigHandler);

let orgLoc = {};
let orgDoc = {};
let orgPath = "";

// start/restart the location
function restart (name) {
    console.log(`Restart: ${name}`);
    //#const loc = orgDoc.locations[location]

    for (location in orgDoc.locations) {
        loc = orgDoc.locations[location]
        if (loc.name == name )
            break;
    }
    //loc = orgLoc;
    logger.info(`Restarting: ${loc.name} - ${name}`)

    loc["path"] = orgPath; // add path
    //loc["device"] = device;
    const worker = new Worker(orgPath + './src/connection.js', {
                                    workerData: { location: loc }
    })
    threads.add(worker)

    worker.on('error', (err) => {
      throw err;
    })
    worker.on('message', (data) => {
       restart (data); // pass location
    });
    worker.on('exit', () => {
      threads.delete(worker)
      console.log(`Thread exiting, ${threads.size} running...`)
    })
}

async function ConnectionService(path, doc) {
  // note for restart
  orgDoc = doc;
  orgPath = path;

  // exit existing workers
  for (let worker of threads) {
    // allow the thread to exit
    worker.postMessage({ exit: true });
    //worker.terminate()
  }
  // really need a timeout/wait to ensure all threads exit
  // that is threads.size reaches 0
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
    worker.on('message', (data) => {
       restart (data); // pass location
    });
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
