#!/usr/bin/env python3
"""
knxaccount.py - account for every KNXnet/IP tunnelling request in a capture:
what kind of frame it is, and for group telegrams what hamon does with it.
With a combined.log extract for the same window, also reconcile the telegrams
hamon should have logged against the Event lines it did log.

    test/secure-gateway/.venv/bin/python utils/knxaccount.py cap.pcap gadpts.json [events.log]
"""
import json, os, re, struct, sys
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dptreal import packets

ACT = {0: 'GroupValue_Read', 1: 'GroupValue_Response', 2: 'GroupValue_Write'}
MSG = {0x29: 'L_Data.ind', 0x2e: 'L_Data.con', 0x11: 'L_Data.req', 0x2b: 'L_Busmon.ind',
       0x2d: 'L_Raw.ind', 0xfc: 'M_PropRead.con', 0xf0: 'M_Reset.ind'}


def main():
    pcap, gafile = sys.argv[1], sys.argv[2]
    evlog = sys.argv[3] if len(sys.argv) > 3 else None
    sites = json.load(open(gafile))
    byaddr = defaultdict(list)
    for name, s in sites.items():
        byaddr[(s['host'], s['port'])].append(name)

    kinds = Counter()
    expect = Counter()        # (site, ga, evt) -> telegrams hamon should log
    first_ts = last_ts = None
    last = {}
    for ts, src, sport, knx in packets(pcap):
        first_ts = first_ts or ts
        last_ts = ts
        cands = byaddr.get((src, sport))
        if not cands:
            kinds['gateway not in hamon.yml'] += 1
            continue
        # -i any sees a container site's packet twice (same bytes), and a
        # gateway two sites share sends each telegram once per tunnel (same
        # cEMI, different channel): count it once. ts is whole seconds
        body = bytes(knx[6 + knx[6]:]) if len(cands) > 1 and len(knx) > 6 else bytes(knx)
        key = (src, sport, body)
        if key in last and ts - last[key] <= 1:
            continue
        last[key] = ts
        if len(knx) < 10:
            kinds['short KNXnet/IP frame'] += 1
            continue
        cemi = knx[6 + knx[6]:]
        code = cemi[0]
        if code != 0x29:
            kinds[f'cEMI {MSG.get(code, hex(code))}'] += 1
            continue
        i = 2 + cemi[1]
        ctrl1, ctrl2 = cemi[i], cemi[i + 1]
        if not ctrl1 & 0x80:
            kinds['extended frame'] += 1
        dst = struct.unpack('>H', cemi[i + 4:i + 6])[0]
        length = cemi[i + 6]
        tpci = cemi[i + 7]
        if not ctrl2 & 0x80:
            if length == 0:
                kinds['device-to-device: transport control (T_Connect/ACK/Disconnect)'] += 1
            else:
                kinds['device-to-device: data (management/ETS)'] += 1
            continue
        if dst == 0:
            kinds['broadcast'] += 1
            continue
        if length == 0:
            kinds['group: no APCI (invalid)'] += 1
            continue
        apci = cemi[i + 8]
        action = ((tpci & 0x03) << 2) | (apci >> 6)
        evt = ACT.get(action)
        if evt is None:
            kinds[f'group: other service {action}'] += 1
            continue
        ga = f'{dst >> 11 & 0x1f}/{dst >> 8 & 0x07}/{dst & 0xff}'
        owners = [c for c in cands if ga in sites[c]['gas']]
        if evt == 'GroupValue_Read':
            kinds['group read (not stored, by design)'] += 1
            continue
        if not owners:
            kinds[f'group {evt.split("_")[1].lower()}: GA has no DPT in hamon'] += 1
            continue
        kinds[f'group {evt.split("_")[1].lower()}: GA with DPT'] += 1
        for site in owners:
            expect[(site, ga, evt)] += 1

    total = sum(kinds.values())
    print(f'{total} tunnelling requests (after removing -i any duplicates)')
    for k, n in kinds.most_common():
        if n:
            print(f'  {n:7d}  {k}')

    if not evlog:
        return
    pat = re.compile(r'>> (\S+ \S+) Event (GroupValue_\w+) "[^"]*" -> "([^"]+)" .*"site":"([^"]+)"')
    seen = Counter()
    for line in open(evlog, errors='replace'):
        m = pat.search(re.sub(r'\x1b\[[0-9;]*m', '', line))
        if m and m.group(2) != 'GroupValue_Read':
            seen[(m.group(4), m.group(3), m.group(2))] += 1
    exp_n, seen_n = sum(expect.values()), sum(seen.values())
    print(f'\nreconcile: capture expects {exp_n} logged events, combined.log has {seen_n}')
    missing = Counter({k: expect[k] - seen.get(k, 0) for k in expect if expect[k] > seen.get(k, 0)})
    extra = Counter({k: seen[k] - expect.get(k, 0) for k in seen if seen[k] > expect.get(k, 0)})
    bysite = Counter()
    for (site, ga, evt), n in missing.items():
        bysite[site] += n
    print(f'  in capture, not logged: {sum(missing.values())} {dict(bysite.most_common(10))}')
    for k, n in missing.most_common(12):
        print('     ', k, n)
    bysite = Counter()
    for (site, ga, evt), n in extra.items():
        bysite[site] += n
    print(f'  logged, not in capture: {sum(extra.values())} {dict(bysite.most_common(10))}')
    for k, n in extra.most_common(8):
        print('     ', k, n)


if __name__ == '__main__':
    main()
