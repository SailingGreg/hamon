#!/usr/bin/env node
/*
 * dedupe.test.js - a chatty GA's repeats written at most once per window,
 * with the held value written late under its own time (src/dedupe.js)
 */
const assert = require('assert')
const { createDedupe, effective } = require('../src/dedupe')

let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++ }

// a fake clock and timers: advance(ms) runs the timers that fall due, in order
function fakeTime(start) {
    let t = start
    let timers = []
    let id = 0
    return {
        now: () => t,
        setTimer: (fn, ms) => { timers.push({ id: ++id, at: t + ms, fn }); return id },
        clearTimer: (h) => { timers = timers.filter((x) => x.id !== h) },
        pending: () => timers.length,
        advance(ms) {
            const end = t + ms
            for (;;) {
                timers.sort((a, b) => a.at - b.at)
                const next = timers[0]
                if (!next || next.at > end) break
                timers.shift()
                t = next.at
                next.fn()
            }
            t = end
        },
    }
}

const T0 = Date.parse('2026-10-16T20:00:00Z')
function setup(window = 30000) {
    const clk = fakeTime(T0)
    const out = [] // [time-or-null, value, at]
    const d = createDedupe(window, (time, args) => out.push([time && time.getTime(), args[0], clk.now()]), clk)
    return { clk, out, d }
}

// --- the window in ms for a location
eq(effective(undefined, undefined), 0, 'no dedupe anywhere: off')
eq(effective(undefined, 30), 30000, 'top-level 30: 30 s')
eq(effective(10, 30), 10000, "site's own value wins")
eq(effective(0, 30), 0, 'site 0: off for that site')
eq(effective('20', undefined), 20000, 'a quoted number works')
eq(effective('x', 30), 0, 'not a number: off')
eq(effective(-5, 30), 0, 'negative: off')
eq(effective(null, 30), 30000, 'site null (empty yaml value) follows the top level')

// --- a 1 Hz repeat: one point per window, the held one under its own time
{
    const { clk, out, d } = setup()
    ok(d.push('1/2/3', 0, [0]), 'first value written now')
    for (let i = 1; i <= 90; i++) { clk.advance(1000); d.push('1/2/3', 0, [0]) }
    // written at 0 (now), then held values flushed at 30 s marks with their own time
    eq(out[0], [null, 0, T0], 'first written as it arrives')
    ok(out.length <= 5, `90 s of 1 Hz repeats -> ${out.length} points`)
    for (const [time, , at] of out.slice(1)) {
        ok(time !== null && time <= at, 'held value carries its own (earlier) time')
    }
}

// --- a change is written at once, after the held repeat (a step stays a step)
{
    const { clk, out, d } = setup()
    d.push('g', 1, [1])
    clk.advance(1000); d.push('g', 1, [1])      // held
    clk.advance(1000); d.push('g', 1, [1])      // held, replaces the last
    clk.advance(1000); ok(d.push('g', 2, [2]), 'change written now')
    eq(out.map((o) => o[1]), [1, 1, 2], 'first, held repeat, change')
    eq(out[1][0], T0 + 2000, 'held repeat keeps its own time (the latest one)')
    eq(out[2][0], null, 'change goes out unstamped')
    eq(clk.pending(), 0, 'no timer left once the held value is out')
}

// --- a value that keeps changing is never held
{
    const { clk, out, d } = setup()
    for (let i = 0; i < 20; i++) { ok(d.push('t', 20 + i / 10, [i]), `ramp step ${i} written`); clk.advance(2000) }
    eq(out.length, 20, 'every changing value written')
}

// --- quiet after a burst: the last repeat lands at the end of the window
{
    const { clk, out, d } = setup()
    d.push('g', 5, ['a'])
    clk.advance(4000); d.push('g', 5, ['b'])
    clk.advance(60000)
    eq(out.map((o) => o[1]), ['a', 'b'], 'held repeat flushed without a new value')
    eq(out[1][0], T0 + 4000, '...under the time it arrived')
    eq(out[1][2], T0 + 30000, '...written at last + window')
}

// --- a repeat after the window is written at once
{
    const { clk, out, d } = setup()
    d.push('g', 5, ['a'])
    clk.advance(31000); ok(d.push('g', 5, ['b']), 'repeat after the window: written now')
    eq(out.length, 2, 'two points')
}

// --- GAs are independent
{
    const { clk, out, d } = setup()
    d.push('a', 1, ['a1']); d.push('b', 1, ['b1'])
    clk.advance(1000); d.push('a', 1, ['a2']); d.push('b', 2, ['b2'])
    eq(out.map((o) => o[1]), ['a1', 'b1', 'b2'], "b's change doesn't flush a's held value")
}

// --- stopping writes what is held
{
    const { clk, out, d } = setup()
    d.push('a', 1, ['a1']); d.push('b', 1, ['b1'])
    clk.advance(1000); d.push('a', 1, ['a2']); d.push('b', 1, ['b2'])
    d.flushAll()
    eq(out.map((o) => o[1]).sort(), ['a1', 'a2', 'b1', 'b2'], 'flushAll writes both held values')
    eq(clk.pending(), 0, 'and clears the timers')
    clk.advance(60000)
    eq(out.length, 4, 'nothing more after flushAll')
}

// --- objects (composite DPTs) never compare equal: always written
{
    const { clk, out, d } = setup()
    d.push('o', { a: 1 }, [1]); clk.advance(1000); d.push('o', { a: 1 }, [2])
    eq(out.length, 2, 'object values pass straight through')
}

console.log(`dedupe: ${checks} checks passed`)
