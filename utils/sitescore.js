#!/usr/bin/env node
/*
 * sitescore.js - how well hamon covers each enabled site: its ETS export, the
 * dptmappings rules it needed, the live GAs it stores, and the problems the
 * logs report. Run from the hamon directory on the server.
 *
 *   node utils/sitescore.js [--json] [--untyped] [--yml hamon.yml] [--days N] [combined.log ...]
 *
 * Logs default to src/combined.log (rotated .gz files are fine). Only event
 * lines labelled with a site ("site":"...") count towards the live GAs.
 *
 * --days N scores only the last N days, so weekly runs cover the same length
 * of time: without log files it reads src/combined.log and the rotated
 * src/combined.log-YYYYMMDD.gz files that can hold that window. Event lines
 * carry a time; UNMAPPED and DEVICE lines don't, and take the time of the last
 * event line before them. The header says which span the logs actually cover.
 *
 * --untyped also lists, per site, the GAs the export has but hamon still has no
 * DPT for: the gaps that turn into UNMAPPED lines once the GA is used. They are
 * grouped by the kind of GA their ETS name says (see family()), so a kind can
 * become one dptmappings name rule; "*" marks the ones seen live. Sites with no
 * live traffic are only counted.
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
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e })   // | head
console.log = () => {}   // parsexml and loadmapping chat on stdout

const args = process.argv.slice(2)
const json = args.includes('--json')
const untyped = args.includes('--untyped')
const ymlAt = args.indexOf('--yml')
const yml = ymlAt >= 0 ? args[ymlAt + 1] : root + 'hamon.yml'
const daysAt = args.indexOf('--days')
const days = daysAt >= 0 ? Number(args[daysAt + 1]) : null
if (days !== null && !(days > 0)) {
    process.stderr.write('--days needs a number of days\n')
    process.exit(2)
}
const logs = args.filter((a, i) => !a.startsWith('--') && (ymlAt < 0 || i !== ymlAt + 1) && (daysAt < 0 || i !== daysAt + 1))

// local time as the log lines write it: "YYYY-MM-DD HH:MM:SS"
const stamp = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().replace('T', ' ').slice(0, 19)
const since = days !== null ? stamp(new Date(Date.now() - days * 24 * 60 * 60 * 1000)) : null
if (logs.length === 0) {
    // a file rotated on day D holds the lines up to D, so one dated before the
    // window's first day holds nothing in it
    const first = since !== null ? since.slice(0, 10).replace(/-/g, '') : null
    const dir = root + 'src/'
    const rotated = fs.readdirSync(dir).filter((f) => /^combined\.log-\d{8}(\.gz)?$/.test(f)).sort()
    if (first !== null) {
        for (const f of rotated) if (f.slice(13, 21) >= first) logs.push(dir + f)
    }
    logs.push(dir + 'combined.log')
}

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
    const s = { exported: 0, withDpt: 0, added: 0, overridden: 0, named: 0, dpt: new Map(), gaps: new Map(), untyped: new Map(), typed: [] }
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
        if (dpt == undefined) { s.untyped.set(key, name); continue }
        s.dpt.set(key, dpt)
        s.typed.push([name, dpt])
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

// the span of time the logs cover inside the window, from the event lines
const span = { first: null, last: null }

async function readLogs(sites) {
    const strip = /\x1b\[[0-9;]*m/g
    const event = /^info: >> (\S+ \S+) Event (GroupValue_\w+) "[^"]*" -> "([^"]+)".*"site":"([^"]+)"/
    const unmapped = /^warn: UNMAPPED (\S+) (\S+) from /
    const device = /^warn: DEVICE (\S+) (\S+) \(.*\) from [^:]+: (.*), payload \S+(?: \((\d+) so far\))?/
    for (const file of logs) {
        let now = null   // the time of the last event line, for lines without one
        let input = fs.createReadStream(file)
        if (file.endsWith('.gz')) input = input.pipe(zlib.createGunzip())
        for await (const raw of readline.createInterface({ input, crlfDelay: Infinity })) {
            const c = raw.charCodeAt(5) === 0x1b || raw.charCodeAt(0) === 0x1b ? raw.replace(strip, '') : raw
            let m
            if ((m = event.exec(c)) !== null) {
                now = m[1]
                if (since !== null && now < since) continue
                if (span.first === null || now < span.first) span.first = now
                if (span.last === null || now > span.last) span.last = now
                const s = sites.get(m[4])
                if (s !== undefined && m[2] !== 'GroupValue_Read') s.live.add(m[3])
                continue
            }
            if (since !== null && (now === null || now < since)) continue
            if ((m = unmapped.exec(c)) !== null) {
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

// the kind of GA an ETS name is, with numbers as "#": names like "Function -
// Room - Item" keep the part before the room and item; for "A - B" the side
// more names share; otherwise the last two words
const norm = (t) => t.trim().replace(/\d+/g, '#')
function family(name, common) {
    const parts = String(name || '').split(' - ').map(norm).filter((p) => p)
    if (parts.length >= 3) return parts.slice(0, -2).join(' - ')
    if (parts.length === 2) return (common.get(parts[1]) || 0) > (common.get(parts[0]) || 0) ? '... - ' + parts[1] : parts[0] + ' - ...'
    const words = (parts[0] || '').split(/\s+/)
    return words.slice(-2).join(' ') || '(no name)'
}

function listUntyped(rows) {
    const gaKey = (g) => g.split('/').map((p) => p.padStart(5, '0')).join('/')
    const withGaps = rows.filter((r) => Object.keys(r.untyped).length).sort((a, b) => a.site.localeCompare(b.site))
    const count = (rs) => rs.reduce((t, r) => t + Object.keys(r.untyped).length, 0)
    const quiet = withGaps.filter((r) => r.live === 0)
    out(`\nuntyped GAs in the exports (no DPT after dptmappings; * = seen live): ${count(withGaps) - count(quiet)} on ` +
        `${withGaps.length - quiet.length} live sites, ${Object.values(withGaps).reduce((t, r) => t + Object.values(r.untyped).filter((u) => u.live).length, 0)} seen live\n`)
    if (quiet.length) out(`(and ${count(quiet)} on sites with no live traffic, not listed: ${quiet.map((r) => r.site).join(' ')})\n`)
    // the DPTs typed GAs of each kind have, on each site and on all of them
    const evidence = new Map(), everywhere = new Map()
    const tally = (m, f, dpt) => { const t = m.get(f) || new Map(); t.set(dpt, (t.get(dpt) || 0) + 1); m.set(f, t) }
    const commons = new Map()
    for (const r of rows) {
        const common = new Map()
        for (const n of Object.values(r.untyped).map((u) => u.name).concat(r.typed.map(([n]) => n))) {
            const parts = String(n || '').split(' - ').map(norm)
            if (parts.length === 2) for (const p of parts) common.set(p, (common.get(p) || 0) + 1)
        }
        commons.set(r.site, common)
        const here = new Map()
        for (const [n, dpt] of r.typed) { const f = family(n, common); tally(here, f, dpt); tally(everywhere, f, dpt) }
        evidence.set(r.site, here)
    }
    const show = (t) => t ? [...t].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d, n]) => `${d.replace('DPT', '')} x${n}`).join(', ') : ''
    for (const r of withGaps.filter((r) => r.live > 0)) {
        const common = commons.get(r.site)
        const fams = new Map()
        for (const [ga, u] of Object.entries(r.untyped)) {
            const f = family(u.name, common)
            const e = fams.get(f) || { gas: [], example: u.name }
            e.gas.push(ga + (u.live ? '*' : ''))
            fams.set(f, e)
        }
        out(`\n${r.site}: ${Object.keys(r.untyped).length} untyped of ${r.exported} exported, ${fams.size} kinds\n`)
        const sorted = [...fams].sort((a, b) => b[1].gas.length - a[1].gas.length || a[0].localeCompare(b[0]))
        for (const [f, e] of sorted) {
            const gas = e.gas.sort((a, b) => gaKey(a.replace('*', '')).localeCompare(gaKey(b.replace('*', ''))))
            const site = show(evidence.get(r.site).get(f)), all = show(everywhere.get(f))
            out(`  ${pad2(gas.length)}  ${f.padEnd(40)} e.g. ${JSON.stringify(e.example)}: ${gas.length > 6 ? gas.slice(0, 6).join(' ') + ` +${gas.length - 6}` : gas.join(' ')}\n`)
            if (site || all) out(`       typed: ${site ? 'here ' + site : 'none here'}${all && all !== site ? '; all sites ' + all : ''}\n`)
        }
    }
}
const pad2 = (n) => String(n).padStart(3)

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
            typed: s.typed,
            untyped: Object.fromEntries([...s.untyped].map(([g, n]) => [g, { name: n, live: s.live.has(g) }])),
            grade: s.live.size ? grade(pctSite, s.device.size) : '-'
        })
    }
    rows.sort((a, b) => (a.grade + a.site).localeCompare(b.grade + b.site))
    if (json) return out(JSON.stringify(rows, null, 1) + '\n')

    const pad = (v, n) => String(v).padStart(n)
    const hours = span.first && span.last ? Math.round((Date.parse(span.last.replace(' ', 'T')) - Date.parse(span.first.replace(' ', 'T'))) / 3600000) : 0
    out((days !== null ? `last ${days} day${days === 1 ? '' : 's'} (since ${since.slice(0, 16)}); ` : '') +
        (span.first ? `site events ${span.first.slice(0, 16)} to ${span.last.slice(0, 16)} (~${hours} h)\n\n` : 'no site events\n\n'))
    const quiet = rows.filter((r) => r.live === 0).map((r) => r.site)
    out(`${'site'.padEnd(14)} ${pad('export', 6)} ${pad('w/DPT', 5)}  ${'rules +/~/='.padEnd(11)} ${pad('live', 5)} ${pad('stored', 6)} ${pad('unmap', 6)} ${pad('device', 7)} ${pad('hamon', 9)}  grade\n`)
    for (const r of rows.filter((r) => r.live > 0)) {
        out(`${r.site.padEnd(14)} ${pad(r.exported, 6)} ${pad(r.exportDptPct === null ? '-' : r.exportDptPct + '%', 5)}  ` +
            `${`${r.rules.added}/${r.rules.overridden}/${r.rules.named}`.padEnd(11)} ${pad(r.live, 5)} ` +
            `${pad(r.storedPct === null ? '-' : r.storedPct + '%', 6)} ${pad((r.unmappedCapped ? '>=' : '') + r.unmapped.length, 6)} ` +
            `${pad(`${r.deviceInvalid}/${r.deviceLength}`, 7)} ${pad(`${Object.keys(r.hamonGaps).length}/${r.hamonGapsExport}`, 9)}  ${r.grade}\n`)
    }
    if (quiet.length) out(`\nno live traffic in these logs: ${quiet.join(' ')}\n`)
    out('\ndevice = GAs with invalid data (7FFFh) / wrong length; hamon = live / exported GAs whose DPT hamon or KNXUltimate can\'t store\n')
    const detail = rows.filter((r) => r.live > 0 && (r.unmapped.length || Object.keys(r.device).length || Object.keys(r.hamonGaps).length))
    for (const r of detail) {
        out(`\n${r.site}\n`)
        if (r.unmapped.length) out(`  unmapped: ${r.unmapped.join(' ')}\n`)
        for (const [ga, d] of Object.entries(r.device)) out(`  device:   ${ga} ${d.invalid ? 'invalid data' : 'wrong length'} x${d.n}\n`)
        // by DPT: mostly date/time, scene and dimming objects, one line each
        const byDpt = new Map()
        for (const [ga, why] of Object.entries(r.hamonGaps)) byDpt.set(why, (byDpt.get(why) || []).concat(ga))
        for (const [why, gas] of byDpt) out(`  hamon:    ${why}: ${gas.length > 6 ? gas.slice(0, 6).join(' ') + ` +${gas.length - 6}` : gas.join(' ')}\n`)
    }
    if (untyped) listUntyped(rows)
})()
