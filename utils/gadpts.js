#!/usr/bin/env node
/*
 * gadpts.js - each enabled site's group addresses with the DPT hamon decodes
 * them as: the ETS export, then dptmappings' address and name rules, then the
 * default subtype, the same order as site.js initDatapoints. Also the
 * gateway's address, so captured traffic can be matched to a site.
 *
 *   node utils/gadpts.js [hamon.yml] > gadpts.json
 *   { "<site>": { "host": "<ip>", "port": 3671, "gas": { "<ga>": "DPT9.001", ... } } }
 */
const fs = require('fs')
const path = require('path')
const dns = require('dns').promises
const yaml = require('js-yaml')
const ets = require('../parsexml')
const { loadmapping, mapstring, mapaddress, addressRules } = require('../src/strtodpt')

const DEFAULT_SUBTYPE = { DPT1: '.001', DPT3: '.007', DPT5: '.001', DPT7: '.001', DPT8: '.001', DPT9: '.001', DPT18: '.001' }
const root = path.join(__dirname, '..') + '/'
console.log = () => {}   // parsexml and loadmapping chat on stdout

;(async () => {
    const conf = yaml.load(fs.readFileSync(process.argv[2] || root + 'hamon.yml', 'utf8'))
    const out = {}
    for (const loc of Object.values(conf.locations || {})) {
        if (!loc || loc.enabled === false || !loc.config || !loc.config.endsWith('.xml')) continue
        let gas
        try { gas = ets.parsexml(root + 'config/' + loc.config) || {} } catch (e) { continue }
        loadmapping(root, loc.name)
        for (const rule of addressRules(loc.name)) {   // GAs a rule adds
            if (rule.dpt !== undefined && !gas.hasOwnProperty(rule.ga)) gas[rule.ga] = { name: rule.name || rule.ga }
        }
        const table = {}
        for (const [key, ga] of Object.entries(gas)) {
            let dpt = ga.dpt
            const arule = mapaddress(loc.name, key)
            if (arule !== undefined && arule.dpt !== undefined && (arule.override || dpt == undefined)) dpt = arule.dpt
            const name = arule !== undefined && arule.name !== undefined ? arule.name : ga.name
            if (dpt == undefined) dpt = mapstring(loc.name, name)
            if (DEFAULT_SUBTYPE[dpt] !== undefined) dpt += DEFAULT_SUBTYPE[dpt]
            if (dpt != undefined) table[key] = dpt
        }
        let host = loc.dns
        try { host = (await dns.lookup(loc.dns, { family: 4 })).address } catch (e) { }
        out[loc.name] = { host, port: Number(loc.port || 3671), gas: table }
    }
    process.stdout.write(JSON.stringify(out) + '\n')
})()
