#!/usr/bin/env python3
"""
dptreal.py - the dptcompare.py check, on real traffic: the group telegrams in
a capture of a server's KNXnet/IP tunnels, each decoded with the DPT hamon
uses for that site's GA (gadpts.js), by knx 2.4.1, KNXUltimate and XKNX.

    tcpdump -i any -s 256 -w cap.pcap 'udp and udp[8:4] = 0x06100420'
    node utils/gadpts.js > gadpts.json
    test/secure-gateway/.venv/bin/python utils/dptreal.py cap.pcap gadpts.json [--examples N]

Only GroupValue_Write/Response are counted (what hamon stores). The payload
is what hamon's shim passes on: the 6 APCI bits for a 1-byte NPDU, otherwise
the data octets.
"""
import json, os, struct, subprocess, sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dptcompare import xknx_decode, accepted, same, HERE
from xknx.dpt import DPTBase, DPTBinary


def packets(path):
    with open(path, 'rb') as f:
        gh = f.read(24)
        endian = '<' if gh[:4] == b'\xd4\xc3\xb2\xa1' else '>'
        linktype = struct.unpack(endian + 'I', gh[20:24])[0]
        while True:
            ph = f.read(16)
            if len(ph) < 16:
                return
            ts, _, incl, _ = struct.unpack(endian + 'IIII', ph)
            data = f.read(incl)
            off = {113: 16, 276: 20, 1: 14}.get(linktype)
            if off is None:
                raise SystemExit(f'unknown linktype {linktype}')
            ip = data[off:]
            if ip[0] >> 4 != 4:
                continue
            ihl = (ip[0] & 0x0f) * 4
            src = '.'.join(str(b) for b in ip[12:16])
            sport = struct.unpack('>H', ip[ihl:ihl + 2])[0]
            yield ts, src, sport, ip[ihl + 8:]


def telegram(knx):
    """(ga, payload hex) for an L_Data.ind group write/response, else None"""
    if len(knx) < 10 or knx[:4] != b'\x06\x10\x04\x20':
        return None
    cemi = knx[6 + knx[6]:]           # skip the connection header
    if len(cemi) < 2 or cemi[0] != 0x29:
        return None
    i = 2 + cemi[1]                   # skip additional info
    if len(cemi) < i + 8:
        return None
    ctrl2 = cemi[i + 1]
    if not ctrl2 & 0x80:              # individual destination
        return None
    dst = struct.unpack('>H', cemi[i + 4:i + 6])[0]
    length, tpci = cemi[i + 6], cemi[i + 7]
    if length == 0 or len(cemi) < i + 9:
        return None
    apci = cemi[i + 8]
    action = ((tpci & 0x03) << 2) | (apci >> 6)
    if action not in (1, 2):          # response, write
        return None
    data = bytes([apci & 0x3f]) if length == 1 else cemi[i + 9:i + 8 + length]
    ga = f'{dst >> 11 & 0x1f}/{dst >> 8 & 0x07}/{dst & 0xff}'
    return ga, data.hex()


def main():
    pcap, gafile = sys.argv[1], sys.argv[2]
    nex = int(sys.argv[sys.argv.index('--examples') + 1]) if '--examples' in sys.argv else 3
    sites = json.load(open(gafile))
    # two sites can share a gateway (one bus, two ETS projects): a telegram
    # belongs to whichever of them has the GA
    byaddr, byip = defaultdict(list), defaultdict(list)
    for name, s in sites.items():
        byaddr[(s['host'], s['port'])].append(name)
        byip[s['host']].append(name)

    seen = Counter()          # (site, ga, dpt, hex) -> telegrams
    unmatched = Counter()
    nodpt = Counter()
    for ts, src, sport, knx in packets(pcap):
        t = telegram(knx)
        if t is None:
            continue
        cands = byaddr.get((src, sport)) or byip.get(src, [])
        if not cands:
            unmatched[f'{src}:{sport}'] += 1
            continue
        ga, hexs = t
        owners = [c for c in cands if ga in sites[c]['gas']]
        if not owners:
            nodpt['/'.join(cands) + ' ' + ga] += 1
            continue
        for site in owners:
            seen[(site, ga, sites[site]['gas'][ga], hexs)] += 1

    uniq = sorted({(dpt, hexs) for (_, _, dpt, hexs) in seen})
    proc = subprocess.run(['node', os.path.join(HERE, 'dptdecode.js')],
                          input='\n'.join(json.dumps([d, h]) for d, h in uniq) + '\n',
                          capture_output=True, text=True, check=True)
    node = {}
    for line in proc.stdout.split('\n'):
        if line:
            d, h, k, u = json.loads(line)
            node[(d, h)] = (k, u)

    tcs = {}
    stats = defaultdict(Counter)       # dpt -> label -> telegrams
    gas = defaultdict(lambda: defaultdict(set))
    examples = defaultdict(list)
    for (site, ga, dpt, hexs), n in seen.items():
        if dpt not in tcs:
            try:
                tcs[dpt] = DPTBase.parse_transcoder(dpt.replace('DPT', ''))
            except Exception:
                tcs[dpt] = None
        tc = tcs[dpt]
        k, u = node[(dpt, hexs)]
        if tc is None:
            x = {'e': 'no xknx transcoder'}
        else:
            kind = 'ok' if (tc.payload_type is DPTBinary and len(hexs) == 2) or \
                (tc.payload_type is not DPTBinary and len(hexs) == 2 * tc.payload_length) else 'long'
            x = xknx_decode(tc, hexs, kind)
        ak, au, ax = accepted(k), accepted(u), accepted(x)
        if ak and au and ax and ('obj' in x or 'enum' in x and x['v'] is None):
            label = 'agree (object, not stored)'
        elif ak and au and ax:
            kv, uv, xv = k['v'], u['v'], x['v']
            if same(kv, uv) and same(uv, xv):
                label = 'agree'
            elif same(kv, uv):
                label = 'knx = kxu, xknx differs'
            elif same(uv, xv):
                label = 'kxu = xknx, knx differs (stored value changed by the switch)'
            else:
                label = 'all three differ'
        elif tc is None and ak and au:
            label = 'agree (knx = kxu, no xknx)' if same(k['v'], u['v']) else 'knx != kxu (no xknx)'
        else:
            label = f'accepts knx={int(ak)} kxu={int(au)} xknx={int(ax)}'
        stats[dpt][label] += n
        gas[dpt][label].add((site, ga))
        if len(examples[(dpt, label)]) < nex and label not in ('agree', 'agree (object, not stored)'):
            examples[(dpt, label)].append((site, ga, hexs, n, k, u, x))

    total = sum(seen.values())
    print(f'{total} group telegrams with a DPT, {len(seen)} distinct site/GA/payload, '
          f'{sum(len(v["gas"]) for v in sites.values())} GAs configured')
    if unmatched:
        print('not matched to a site:', dict(unmatched.most_common(10)))
    if nodpt:
        print('GA without a DPT in hamon (not stored):', dict(nodpt.most_common(20)))
    for dpt in sorted(stats, key=lambda d: -sum(stats[d].values())):
        s = stats[dpt]
        print(f'\n{dpt}: {sum(s.values())} telegrams')
        for label, n in s.most_common():
            print(f'    {label:62s} {n:7d} telegrams, {len(gas[dpt][label])} GAs')
            for site, ga, hexs, cnt, k, u, x in examples.get((dpt, label), []):
                print(f'        {site} {ga} {hexs} x{cnt}: knx={json.dumps(k)} kxu={json.dumps(u)} xknx={json.dumps(x)}')


if __name__ == '__main__':
    main()
