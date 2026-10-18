#!/usr/bin/env node
/*
 * sitescore.js - how well hamon covers each enabled site: its ETS export, the
 * dptmappings rules it needed, the live GAs it stores, and the problems the
 * logs report. Run from the hamon directory on the server.
 *
 *   node utils/sitescore.js [--json] [--yml hamon.yml] [combined.log ...]
 *
 * Logs default to src/combined.log (rotated .gz files are fine). Only event
 * lines labelled with a site ("site":"...") count towards the live GAs.
 *
 * Columns, one row per site:
 *   export   GAs in the ETS export, and the share that have a DPT there
 *   rules    dptmappings fixes: +added (GA not in the export), ~overridden
 *            (wrong ETS DPT), =named (DPT from an address or name rule)
 *   live     distinct GAs written or answered on the bus, in the logs
 *   stored   share of the live GAs hamon stores
 *   unmapped live GAs that still have no DPT (UNMAPPED, or an event to a
 *            GA without a DPT), less any that a rule now maps. ">=" when a
 *            site hit the per-start UNMAPPED limit
 *   device   GAs with DEVICE warnings: invalid data (7FFFh) / wrong length
 *   hamon    GAs whose DPT hamon or KNXUltimate can't store: no type name,
 *            no KNXUltimate subtype, or an object value (composites are not
 *            stored yet). Ours to fix, not the integrator's
 *   grade    the worse of stored and device (A best .. D); export, rules and
 *            hamon gaps are shown but not graded
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const readline = require('readline')
const yaml = require('js-yaml')
const ets = require('../parsexml')
const { loadmapping, mapstring, mapaddress, addressRules } = require('../src/strtodpt')
const { dptInfo, dptMain, OBJECT_DPTS } = require('../src/dptnames')
const kxu = require('knxultimate/build/dptlib')

// as site.js initDatapoints
const DEFAULT_SUBTYPE = { DPT1: '.001', DPT3: '.007', DPT5: '.001', DPT7: '.001', DPT8: '.001', DPT9: '.001', DPT18: '.001' }
const root = path.join(__dirname, '..') + '/'
const out = process.stdout.write.bind(process.stdout)
console.log = () => {}   // parsexml and loadmapping chat on stdout

const args = process.argv.slice(2)
const json = args.includes('--json')
const ymlAt = args.indexOf('--yml')
const yml = ymlAt >= 0 ? args[ymlAt + 1] : root + 'hamon.yml'
const logs = args.filter((a, i) => !a.startsWith('--') && (ymlAt < 0 || i !== ymlAt + 1))
if (logs.length === 0) logs.push(root + 'src/combined.log')

// why KNXUltimate or hamon can't store a DPT, or undefined if it can
const hamonGapCache = new Map()
function hamonGap(dpt) {
    if (!hamonGapCache.has(dpt)) {
        let why
        if (OBJECT_DPTS.has(dptMain(dpt))) why = 'object'
        else if (dptInfo(dpt) === undefined) why = 'no type name'
        else {
            try { if (!kxu.resolve(dpt).subtype) why = 'no KNXUltimate subtype' } catch (e) { why = 'not in KNXUltimate' }
        }
        hamonGapCache.set(dpt, why)
    }
    return hamonGapCache.get(dpt)
}

// a site's GAs as hamon resolves them (see utils/gadpts.js)
function siteTable(loc) {
    const gas = ets.parsexml(root + 'config/' + loc.config) || {}
    const s = { exported: 0, withDpt: 0, added: 0, overridden: 0, named: 0, dpt: new Map(), gaps: new Map() }
    for (const ga of Object.values(gas)) { s.exported++; if (ga.dpt != undefined) s.withDpt++ }
    loadmapping(root, loc.name)
    for (const rule of addressRules(loc.name)) {
        if (rule.dpt !== undefined && !gas.hasOwnProperty(rule.ga)) { gas[rule.ga] = { name: rule.name || rule.ga }; s.added++ }
    }
    for (const [key, ga] of Object.entries(gas)) {
        let dpt = ga.dpt
        const arule = mapaddress(loc.name, key)
        if (arule !== undefined && arule.dpt !== undefined && (arule.override || dpt == undefined)) {
            if (dpt != undefined) s.overridden++
            else s.named++
            dpt = arule.dpt
        }
        const name = arule !== undefined && arule.name !== undefined ? arule.name : ga.name
        if (dpt == undefined) { dpt = mapstring(loc.name, name); if (dpt != undefined) s.named++ }
        if (DEFAULT_SUBTYPE[dpt] !== undefined) dpt += DEFAULT_SUBTYPE[dpt]
        if (dpt == undefined) continue
        s.dpt.set(key, dpt)
        const why = hamonGap(dpt)
        if (why !== undefined) s.gaps.set(key, `${dpt} ${why}`)
    }
    s.named -= s.added   // an added GA's rule is counted once, as added
    return s
}

function grade(pct, dev) {
    const g1 = pct === null ? 'A' : pct >= 99 ? 'A' : pct >= 95 ? 'B' : pct >= 85 ? 'C' : 'D'
    const g2 = dev === 0 ? 'A' : dev <= 2 ? 'B' : dev <= 10 ? 'C' : 'D'
    return g1 > g2 ? g1 : g2
}

async function readLogs(sites) {
    const strip = /\x1b\[[0-9;]*m/g
    const event = /^info: >> \S+ \S+ Event (GroupValue_\w+) "[^"]*" -> "([^"]+)".*"site":"([^"]+)"/
    const unmapped = /^warn: UNMAPPED (\S+) (\S+) from /
    const device = /^warn: DEVICE (\S+) (\S+) \(.*\) from [^:]+: (.*), payload \S+(?: \((\d+) so far\))?/
    for (const file of logs) {
        let input = fs.createReadStream(file)
        if (file.endsWith('.gz')) input = input.pipe(zlib.createGunzip())
        for await (const raw of readline.createInterface({ input, crlfDelay: Infinity })) {
            const c = raw.charCodeAt(5) === 0x1b || raw.charCodeAt(0) === 0x1b ? raw.replace(strip, '') : raw
            let m
            if ((m = event.exec(c)) !== null) {
                const s = sites.get(m[3])
                if (s !== undefined && m[1] !== 'GroupValue_Read') s.live.add(m[2])
            } else if ((m = unmapped.exec(c)) !== null) {
                const s = sites.get(m[1])
                if (s === undefined) continue
                s.live.add(m[2]); s.unmappedSeen.add(m[2])
                if (c.includes('no more logged')) s.capped = true
            } else if ((m = device.exec(c)) !== null) {
                const s = sites.get(m[1])
                if (s === undefined) continue
                const d = s.device.get(m[2]) || { n: 0, invalid: m[3].includes('7FFFh') }
                d.n = Math.max(d.n + 1, Number(m[4] || 0))
                s.device.set(m[2], d)
            }
        }
    }
}

;(async () => {
    const conf = yaml.load(fs.readFileSync(yml, 'utf8'))
    const sites = new Map()
    for (const loc of Object.values(conf.locations || {})) {
        if (!loc || loc.enabled === false || !loc.config || !loc.config.endsWith('.xml')) continue
        let s
        try { s = siteTable(loc) } catch (e) { continue }
        sites.set(loc.name, Object.assign(s, { live: new Set(), unmappedSeen: new Set(), capped: false, device: new Map() }))
    }
    await readLogs(sites)

    const rows = []
    for (const [name, s] of sites) {
        const stored = [...s.live].filter((g) => s.dpt.has(g) && !s.gaps.has(g)).length
        const unmapped = [...s.live].filter((g) => !s.dpt.has(g))
        const liveGaps = [...s.live].filter((g) => s.gaps.has(g))
        const pct = s.live.size ? 100 * stored / s.live.size : null
        // the integrator's gaps: unmapped GAs and device problems; hamon's own
        // gaps don't count against the site
        const pctSite = s.live.size - liveGaps.length ? 100 * stored / (s.live.size - liveGaps.length) : null
        const invalid = [...s.device.values()].filter((d) => d.invalid).length
        rows.push({
            site: name,
            exported: s.exported,
            exportDptPct: s.exported ? Math.round(100 * s.withDpt / s.exported) : null,
            rules: { added: s.added, overridden: s.overridden, named: s.named },
            live: s.live.size,
            storedPct: pct === null ? null : Math.round(pct * 10) / 10,
            unmapped: unmapped.sort(),
            unmappedCapped: s.capped,
            device: Object.fromEntries([...s.device].sort()),
            deviceInvalid: invalid,
            deviceLength: s.device.size - invalid,
            hamonGaps: Object.fromEntries([...s.gaps].filter(([g]) => s.live.has(g)).sort()),
            hamonGapsExport: s.gaps.size,
            grade: s.live.size ? grade(pctSite, s.device.size) : '-'
        })
    }
    rows.sort((a, b) => (a.grade + a.site).localeCompare(b.grade + b.site))
    if (json) return out(JSON.stringify(rows, null, 1) + '\n')

    const pad = (v, n) => String(v).padStart(n)
    out(`${'site'.padEnd(14)} ${pad('export', 6)} ${pad('w/DPT', 5)}  ${'rules +/~/='.padEnd(11)} ${pad('live', 5)} ${pad('stored', 6)} ${pad('unmap', 6)} ${pad('device', 7)} ${pad('hamon', 9)}  grade\n`)
    for (const r of rows) {
        out(`${r.site.padEnd(14)} ${pad(r.exported, 6)} ${pad(r.exportDptPct === null ? '-' : r.exportDptPct + '%', 5)}  ` +
            `${`${r.rules.added}/${r.rules.overridden}/${r.rules.named}`.padEnd(11)} ${pad(r.live, 5)} ` +
            `${pad(r.storedPct === null ? '-' : r.storedPct + '%', 6)} ${pad((r.unmappedCapped ? '>=' : '') + r.unmapped.length, 6)} ` +
            `${pad(`${r.deviceInvalid}/${r.deviceLength}`, 7)} ${pad(`${Object.keys(r.hamonGaps).length}/${r.hamonGapsExport}`, 9)}  ${r.grade}\n`)
    }
    out('\ndevice = GAs with invalid data (7FFFh) / wrong length; hamon = live / exported GAs whose DPT hamon or KNXUltimate can\'t store\n')
    const detail = rows.filter((r) => r.unmapped.length || Object.keys(r.device).length || Object.keys(r.hamonGaps).length)
    for (const r of detail) {
        out(`\n${r.site}\n`)
        if (r.unmapped.length) out(`  unmapped: ${r.unmapped.join(' ')}\n`)
        for (const [ga, d] of Object.entries(r.device)) out(`  device:   ${ga} ${d.invalid ? 'invalid data' : 'wrong length'} x${d.n}\n`)
        for (const [ga, why] of Object.entries(r.hamonGaps)) out(`  hamon:    ${ga} ${why}\n`)
    }
})()
