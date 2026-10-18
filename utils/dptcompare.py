#!/usr/bin/env python3
"""
dptcompare.py - decode the same payloads with knx 2.4.1, KNXUltimate 6.2.0
(both via dptdecode.js) and XKNX, and report where they disagree.

    test/secure-gateway/.venv/bin/python utils/dptcompare.py DPTLIST [--examples N]

DPTLIST: one "<ETS DPT> <count>" per line (DPST-9-1 3008, DPT-5 142, ...), the
DPTs the sites' GA exports use. The count is only shown, to weigh results.

Per DPT, payloads of the right length (all of them up to 2 bytes, a seeded
sample above), plus payloads one byte short and one byte long, which is what
a GA typed wrongly in ETS delivers. Values that decode to objects (DPT 3, 10,
11, 18, 19 ...) are compared on accept/reject only: hamon doesn't store them.
"""
import json, os, random, subprocess, sys, enum
from collections import Counter, defaultdict

from xknx.dpt import DPTBase, DPTArray, DPTBinary

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SUBTYPE = {1: 1, 3: 7, 5: 1, 7: 1, 8: 1, 9: 1, 18: 1}   # as src/site.js


def hamon_id(ets):
    """ETS DPT -> (hamon/knx id, xknx id) as site.js resolves it"""
    parts = ets.split('-')
    main = int(parts[1])
    sub = int(parts[2]) if parts[0] == 'DPST' else DEFAULT_SUBTYPE.get(main)
    if sub is None:
        return f'DPT{main}', str(main)
    return f'DPT{main}.{sub:03d}', f'{main}.{sub:03d}'


def payloads(tc, rnd):
    """(kind, hex) pairs: kind 'ok' = right length, 'short'/'long' = not"""
    if tc.payload_type is DPTBinary:
        for v in range(64):
            yield 'ok', f'{v:02x}'
        for v in (0x0100, 0x0001, 0xffff):
            yield 'long', f'{v:04x}'
        return
    n = tc.payload_length
    if n == 1:
        body = [bytes([v]) for v in range(256)]
    elif n == 2:
        body = [v.to_bytes(2, 'big') for v in range(65536)]
    else:
        edges = [bytes([b] * n) for b in (0x00, 0xff, 0x7f, 0x80, 0x01)]
        body = edges + [bytes(rnd.getrandbits(8) for _ in range(n)) for _ in range(4000)]
    for b in body:
        yield 'ok', b.hex()
    for _ in range(64):
        if n > 1:
            yield 'short', bytes(rnd.getrandbits(8) for _ in range(n - 1)).hex()
        yield 'long', bytes(rnd.getrandbits(8) for _ in range(n + 1)).hex()


def xknx_decode(tc, hexs, kind):
    raw = bytes.fromhex(hexs)
    if tc.payload_type is DPTBinary and kind == 'ok':
        payload = DPTBinary(raw[0])
    else:
        payload = DPTArray(raw)
    try:
        v = tc.from_knx(payload)
    except Exception as e:
        return {'e': type(e).__name__}
    if isinstance(v, bool) or v is None:
        return {'v': v}
    if isinstance(v, enum.Enum):
        return {'enum': v.name, 'v': raw[0] if len(raw) == 1 else None}
    if isinstance(v, (int, float, str)):
        return {'v': v}
    return {'obj': type(v).__name__}


def accepted(r):
    return 'v' in r and r['v'] is not None and r['v'] != 'Invalid Date' or 'obj' in r


def same(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return bool(a) == bool(b) and type(a) in (bool, int) and type(b) in (bool, int)
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        # xknx rounds 4-byte floats to 7 significant digits
        return abs(a - b) <= 1e-6 * max(1.0, abs(a), abs(b))
    if isinstance(a, str) and isinstance(b, str):
        return a.rstrip('\x00 ') == b.rstrip('\x00 ')
    return a == b


def main():
    listfile = sys.argv[1]
    nex = int(sys.argv[sys.argv.index('--examples') + 1]) if '--examples' in sys.argv else 3
    rnd = random.Random(1)
    dpts = []
    for line in open(listfile):
        if line.strip():
            ets, count = line.split()
            dpts.append((ets, int(count)))

    jobs, meta = [], {}
    for ets, count in dpts:
        hid, xid = hamon_id(ets)
        try:
            tc = DPTBase.parse_transcoder(xid)
        except Exception:
            tc = None
        if hid in meta:   # e.g. DPST-1-1 and DPT-1 are both DPT1.001
            e, c, t = meta[hid]
            meta[hid] = (f'{e}+{ets}', c + count, t)
            continue
        if tc is None:
            meta[hid] = (ets, count, None)
            continue
        meta[hid] = (ets, count, tc)
        for kind, hexs in payloads(tc, rnd):
            jobs.append((hid, hexs, kind))

    proc = subprocess.run(['node', os.path.join(HERE, 'dptdecode.js')],
                          input='\n'.join(json.dumps([h, x]) for h, x, _ in jobs) + '\n',
                          capture_output=True, text=True, check=True)
    node = {}
    for line in proc.stdout.split("\n"):
        if not line:
            continue
        hid, hexs, k, u = json.loads(line)
        node[(hid, hexs)] = (k, u)

    stats = defaultdict(Counter)
    examples = defaultdict(list)
    for hid, hexs, kind in jobs:
        tc = meta[hid][2]
        k, u = node[(hid, hexs)]
        x = xknx_decode(tc, hexs, kind)
        ak, au, ax = accepted(k), accepted(u), accepted(x)
        s = stats[hid]
        s[f'{kind}:n'] += 1
        if (ak, au, ax) == (True, True, True):
            if 'obj' in x or 'enum' in x and x['v'] is None:
                s[f'{kind}:all accept (object)'] += 1
                continue
            kv, uv, xv = k['v'], u['v'], x['v']
            if same(kv, uv) and same(uv, xv):
                s[f'{kind}:agree'] += 1
                continue
            label = ('knx' if not same(kv, xv) else '') + ('+kxu' if not same(uv, xv) else '')
            label = f'{kind}:value differs from xknx: {label.lstrip("+")}' if label else f'{kind}:knx!=kxu'
        else:
            label = f'{kind}:accepts knx={int(ak)} kxu={int(au)} xknx={int(ax)}'
        s[label] += 1
        if len(examples[(hid, label)]) < nex:
            examples[(hid, label)].append((hexs, k, u, x))

    for hid, (ets, count, tc) in meta.items():
        if tc is None:
            print(f'\n{hid} ({ets}, {count} GAs): xknx has no transcoder')
            continue
        s = stats[hid]
        print(f'\n{hid} ({ets}, {count} GAs) xknx {tc.__name__} '
              f'{"binary" if tc.payload_type is DPTBinary else f"{tc.payload_length} bytes"}')
        for label, n in sorted(s.items()):
            if label.endswith(':n'):
                continue
            total = s[label.split(':')[0] + ':n']
            print(f'    {label:58s} {n:6d}/{total}')
            for hexs, k, u, x in examples.get((hid, label), []):
                print(f'        {hexs:16s} knx={json.dumps(k)} kxu={json.dumps(u)} xknx={json.dumps(x)}')


if __name__ == '__main__':
    main()
