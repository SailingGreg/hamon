// index.js
// run with node --experimental-worker index.js on Node.js 10.x
const { Worker } = require('worker_threads')
const fs = require('fs')
const yaml = require('js-yaml')

const fileArg = 'hamon.yml'
let knxnetIP = 'ha-test.dyndns.org'
let knxnetPort = 50001

if (fs.existsSync('./' + fileArg)) {
  console.log('Parsing configuration file %s', fileArg)
} else {
  console.log("Configuration file %s doesn't exist", fileArg)
  return 1
}

// this parse and expands the configuration
const doc = yaml.load(fs.readFileSync(fileArg, 'utf8'))

async function runService() {
  for (deploy in doc['locations']) {
    install = doc['locations'][deploy]
    console.log(
      '\t %s %s %s %d',
      deploy,
      install['name'],
      install['dns'],
      install['port']
    )
    knxnetIP = install['dns']
    knxnetPort = install['port']

    new Promise((resolve, reject) => {
      const worker = new Worker('./ha-test.js', {
        workerData: { knxnetIP, knxnetPort, name: install.name }
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

async function run() {
  const result = await runService('world')
  console.log(result)
}

run().catch((err) => console.error(err))
