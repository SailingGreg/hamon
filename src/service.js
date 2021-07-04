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
//const dnsSync = require('dns-sync')

let firstRun = true
//var dnsEntry = ''
const threads = new Set()

const getDoc = (hamonConfig) => yaml.load(fs.readFileSync(hamonConfig, 'utf8'));

let sigcnt = 0;
// deal with signals and exit gracefully
function sigHandler(signal) {
    let ttype = typeof signal;
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

//let orgLoc = {};
//let orgDoc = {};
let originalDoc = {};
let orgPath = "";

function start_worker(path, loc) {

    loc["path"] = path; // add path

    /*
    // if still link then ensure it is terminated!
    if (loc["worker"] != null) {
        loc["worker"].postMessage({ exit: true });
    }
    */
    loc["worker"]=""; // delete the worker so the structure can be cloned

    const worker = new Worker(path + './src/connection.js', {
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

    return (worker);
}

// find the location - returns null if 'new'
function findLoc (name, oDoc) {
    for (location in oDoc.locations) {
        const loc = oDoc.locations[location]
        if (loc.name == name )
            return (loc);
    }
    return null;
}

// compare locations
function compareLoc(oldLoc, newLoc) {
    let change = false;

    // do a field by field comparison - but name excluded!
    //if (oldLoc['name'] != newLoc['name']) change = true;
    if (oldLoc['dns'] != newLoc['dns']) change = true;
    if (oldLoc['port'] != newLoc['port']) change = true;
    if (oldLoc['device'] != newLoc['device']) change = true;
    if (oldLoc['logging'] != newLoc['logging']) change = true;
    if (oldLoc['phyAddr'] != newLoc['phyAddr']) change = true;
    if (oldLoc['config'] != newLoc['config']) change = true;

    return change; // return flag
}

// start/restart the location
function restart (name) {
    console.log(`Restart: ${name}`);
    let loc = [];

    // find the location - user loc = findLoc(name originalDoc);
    for (location in originalDoc.locations) {
        loc = originalDoc.locations[location]
        if (loc.name == name )
            break;
    }
    //loc = orgLoc;
    logger.info(`Restarting: ${loc.name} - ${name}`)

    // and start it
    let wrk = start_worker(orgPath, loc);
    loc["worker"] = wrk; // and recorded the 'worker'

}


// called with current doc for config file
async function ConnectionService(firstrun, path, doc) {
  // note for restart
  //orgDoc = doc;

  orgPath = path;
  let wrk = "";

  /*
  // exit existing workers
  for (let worker of threads) {
    // allow the thread to exit
    worker.postMessage({ exit: true });
    //worker.terminate()
  }
  // really need a timeout/wait to ensure all threads exit
  // that is threads.size reaches 0
  threads.clear()
  */
  // iterate over the 'existing' config and see if new or changed
  for (location in doc.locations) {
    let loc = doc.locations[location]
    logger.info(`Checking: ${loc.name} ${loc.dns} ${loc.port} ${loc.device}`)

    let stats = fs.statSync(path + loc.config);
    if (firstrun != true) { // check if there is a change
        // config change?
        let oldLoc = findLoc(loc.name, originalDoc);

        if (oldLoc != null) {

            // if config change or mtime for config file
            if (compareLoc(oldLoc, loc) ||
                    (stats.mtimeMs != oldLoc['mtime'])) {
                // restart so terminate and start
                let diff = stats.mtimeMs - oldLoc["mtime"];
                logger.info(`Change so restarting: ${loc.name} ${diff}`)

                //terminate and restart
                // we don't need to delete as it is done on exit
                wrk = oldLoc["worker"];
                //console.log("wrk is null? ", wrk == null);
                if (wrk != null) {
                    logger.info("Worker terminating");
                    wrk.postMessage({ exit: true });
                } else {
                    logger.error("Worker is null - can't terminate");
                }

                wrk = start_worker(path, loc);
                loc["worker"] = wrk;
                //doc.locations[location]["worker"] = wrk;

            } else { // do nothing
                logger.info(`No change for: ${loc.name}`);
                // ensure the 'worker' is noted - we address mtime below
                loc["worker"] = oldLoc["worker"];
            }
 
        } else { // new entry in config file
            //start it
            logger.info(`New entry for: ${loc.name}`)
            wrk = start_worker(path, loc);
            loc["worker"] = wrk;
            //doc.locations[location]["worker"] = wrk;
        }

    } else { // first run so just start it
        logger.info(`First run for: ${loc.name}`)
        // start worker
        wrk = start_worker(path, loc);
        loc["worker"] = wrk;
        //doc.locations[location]["worker"] = wrk;
    }

    // note the current config file stamp
    loc["mtime"] = stats.mtimeMs;
    //console.log("Loc ", loc);
  }
}

let last_time = 0;
let d = new Date().getTime();

// main entry
async function runService(path, hamonConfig) {
  fs.watchFile(hamonConfig, function (curr, present) {
      //console.log("fs.watch: ", event, filename);
      /*
       * put a guard in here so resets only if not called with the last
       * 10 seconds?
       */
        d = new Date().getTime(); // refresh time
        logger.info("runTime %d -> %d", d, last_time);
        if (d > (last_time + (15 * 1000))) {
            logger.info("Checking .... %d", (d - last_time));
        
            // reload so changes available
            let newDoc = getDoc(hamonConfig);
            let rs = ConnectionService(false, path, newDoc);
            originalDoc = newDoc;
            last_time = d; // note time
       
            return rs;
        }
    //return ConnectionService(path, getDoc(hamonConfig))
  })

  if (firstRun) {
    firstRun = false
    originalDoc = getDoc(hamonConfig); // note so it availabe
    return ConnectionService(true, path, originalDoc);
     // getDoc(hamonConfig))
  }
}

module.exports.runService = runService
