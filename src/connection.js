/*
 * connection.js - a worker thread running one site (src/site.js)
 *
 * The default: service.js starts one of these per enabled site. With the
 * top-level `threads: false` in hamon.yml the sites run in service.js's own
 * thread instead and this file isn't used.
 *
 * The site's hooks become messages to service.js, as before:
 *   { connected: name }                     the tunnel is up
 *   { stopped: name, reason, detail }       blocked ('dns', 'unreachable')
 *   name                                    timed out: restart with back-off
 *   an uncaught error                       worker 'error': restart
 */
const { workerData, parentPort } = require('worker_threads')
const { createSite } = require('./site')

const { name } = workerData.location

// label everything this worker prints (knx library warnings, stray console.log)
// with the site name, so lines in hamon.log say which site they came from -
// our own logger calls go to combined.log and already carry the name. A line
// that already starts with the label (site.js's own) isn't labelled twice
const label = `[${name}] `
for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream)
    let lineStart = true
    stream.write = (chunk, ...rest) => {
        if (typeof chunk !== 'string') {
            chunk = chunk.toString()
            if (typeof rest[0] === 'string') rest.shift() // encoding was for the buffer
        }
        const lines = chunk.split(/(?<=\n)/)
        const out = lines.map((l, i) => ((i > 0 || lineStart) && l !== '' && !l.startsWith(label) ? label : '') + l).join('')
        lineStart = chunk.endsWith('\n')
        return write(out, ...rest)
    }
}

const site = createSite(workerData.location, workerData, {
    connected: () => parentPort.postMessage({ connected: name }),
    stopped: (reason, detail) => {
        parentPort.postMessage({ stopped: name, reason, detail })
        process.exit(0)
    },
    timeout: () => {
        parentPort.postMessage(name)
        process.exit(1)
    },
    error: (err) => { setImmediate(() => { throw err }) }, // a worker 'error' in service.js
})

// exit if signaled
parentPort.on('message', (value) => {
    if (value && value.exit) site.stop().then(() => process.exit(0))
})

site.start().catch((err) => { setImmediate(() => { throw err }) })
