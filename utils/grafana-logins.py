#!/usr/bin/env python3
"""Grafana logins and users, kept so the role mapping can be judged from use.

Grafana OSS has no audit log, and its session table (user_auth_token) only
holds live sessions, so history is lost as they expire. `record` (hourly from
cron) reads grafana.db read-only and appends to a JSON-lines file:

  login   a new session: user, role, IP, browser (its created time)
  active  a session used since the last run (its last-seen time and IP)
  role    a user's org role changed
  failed  a failed login attempt (login_attempt table)

`report` summarises the last N days per user: role, logins, active days, IPs,
dashboard saves (dashboard_version), hamon-upload use (its logs/access.jsonl),
and notes where the role and the use don't match. It decides nothing.

  utils/grafana-logins.py record
  utils/grafana-logins.py report [--days 7]
"""
import argparse
import datetime as dt
import json
import os
import sqlite3
import sys
import time

HOME = os.path.expanduser('~')
DB = os.environ.get('GRAFANA_DB', '/var/lib/grafana/grafana.db')
EVENTS = os.environ.get('GRAFANA_LOGINS', os.path.join(HOME, 'hamon/tmp/grafana-logins.jsonl'))
STATE = EVENTS + '.state'
UPLOAD_LOG = os.environ.get('UPLOAD_ACCESS_LOG', os.path.join(HOME, 'hamon-upload/logs/access.jsonl'))
ROLE_RANK = {'Viewer': 1, 'Editor': 2, 'Admin': 3}


def iso(ts):
    return dt.datetime.fromtimestamp(int(ts), dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse(s):
    return dt.datetime.strptime(s[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=dt.timezone.utc).timestamp()


def connect(db):
    return sqlite3.connect('file:%s?mode=ro' % db, uri=True, timeout=10)


def users(con):
    """id -> {login, role, admin, last_seen} for people (not service accounts);
    role is the main org's (lowest org id)"""
    out = {}
    q = ('select u.id, u.login, u.is_admin, u.last_seen_at, o.role from user u '
         'left join org_user o on o.user_id = u.id where coalesce(u.is_service_account, 0) = 0 '
         'order by u.id, o.org_id desc')
    for uid, login, admin, seen, role in con.execute(q):
        out[uid] = {'login': login, 'role': role or 'none', 'admin': bool(admin), 'last_seen': seen}
    return out


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {'last': 0, 'tokens': [], 'roles': {}}


def record(args):
    con = connect(args.db)
    now = int(time.time())
    st = load_state()
    known = set(st.get('tokens', []))
    last = st.get('last', 0)
    us = users(con)
    events = []
    rows = con.execute('select id, user_id, created_at, seen_at, client_ip, user_agent from user_auth_token').fetchall()
    for tid, uid, created, seen, ip, ua in rows:
        u = us.get(uid, {'login': '?%s' % uid, 'role': 'none'})
        base = {'user': u['login'], 'id': uid, 'role': u['role'], 'ip': ip}
        if tid not in known:
            events.append(dict(t=iso(created), event='login', ua=(ua or '')[:120], **base))
        if seen and seen > last:
            events.append(dict(t=iso(seen), event='active', **base))
    roles = st.get('roles', {})
    for uid, u in us.items():
        prev = roles.get(str(uid))
        if prev is not None and prev != u['role']:
            events.append({'t': iso(now), 'event': 'role', 'user': u['login'], 'id': uid, 'from': prev, 'to': u['role']})
        roles[str(uid)] = u['role']
    try:
        for name, ip, created in con.execute('select username, ip_address, created from login_attempt where created > ?', (last,)):
            events.append({'t': iso(created), 'event': 'failed', 'user': name, 'ip': ip})
    except sqlite3.Error:
        pass  # older/newer schema: skip
    events.sort(key=lambda e: e['t'])
    os.makedirs(os.path.dirname(EVENTS), exist_ok=True)
    with open(EVENTS, 'a') as f:
        for e in events:
            f.write(json.dumps(e) + '\n')
    tmp = STATE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'last': now, 'tokens': sorted(r[0] for r in rows), 'roles': roles}, f)
    os.replace(tmp, STATE)
    if args.verbose:
        print('%d event(s), %d live session(s)' % (len(events), len(rows)))


def read_jsonl(path, since):
    out = []
    try:
        with open(path) as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if parse(e.get('t', '1970-01-01T00:00:00')) >= since:
                    out.append(e)
    except OSError:
        pass
    return out


def report(args):
    con = connect(args.db)
    since = time.time() - args.days * 86400
    us = users(con)
    by_login = {u['login']: dict(u, id=uid) for uid, u in us.items()}
    rows = {}

    def row(login):
        if login not in rows:
            rows[login] = {'logins': 0, 'days': set(), 'ips': set(), 'saves': 0, 'boards': set(),
                           'up_visits': 0, 'up_changes': [], 'failed': 0}
        return rows[login]

    for e in read_jsonl(EVENTS, since):
        r = row(e.get('user', '?'))
        if e['event'] == 'login':
            r['logins'] += 1
        if e['event'] in ('login', 'active'):
            r['days'].add(e['t'][:10])
            if e.get('ip'):
                r['ips'].add(e['ip'])
        if e['event'] == 'failed':
            r['failed'] += 1
    q = ('select v.created_by, d.title from dashboard_version v join dashboard d on d.id = v.dashboard_id '
         'where v.created >= ?')
    for uid, title in con.execute(q, (dt.datetime.utcfromtimestamp(since).strftime('%Y-%m-%d %H:%M:%S'),)):
        u = us.get(uid)
        if u:
            r = row(u['login'])
            r['saves'] += 1
            r['boards'].add(title)
    refused = 0
    for e in read_jsonl(UPLOAD_LOG, since):
        if e.get('action') == 'refused':
            refused += 1
            continue
        r = row(e.get('user', '?'))
        if e.get('ip'):
            r['ips'].add(e['ip'])
        if e.get('action') == 'visit':
            r['up_visits'] += 1
        else:
            r['up_changes'].append('%s %s %s' % (e['t'][:16], e.get('action'), e.get('detail', '')))

    print('Grafana users, last %d days (to %s UTC)' % (args.days, dt.datetime.utcnow().strftime('%Y-%m-%d %H:%M')))
    print('%-28s %-7s %6s %5s %4s %6s %7s %7s' % ('user', 'role', 'logins', 'days', 'IPs', 'saves', 'upload', 'changes'))
    notes = []
    order = sorted(rows, key=lambda n: (-ROLE_RANK.get(by_login.get(n, {}).get('role'), 0), n))
    for n in order:
        r = rows[n]
        role = by_login.get(n, {}).get('role', '?')
        print('%-28s %-7s %6d %5d %4d %6d %7d %7d' % (n[:28], role, r['logins'], len(r['days']), len(r['ips']),
                                                    r['saves'], r['up_visits'], len(r['up_changes'])))
        if role in ('Admin', 'Editor') and r['saves'] == 0 and not r['up_changes'] and r['days']:
            notes.append('%s: %s, no dashboard saves or hamon-upload changes - Viewer would do' % (n, role))
        if role != 'Admin' and (r['up_visits'] or r['up_changes']):
            notes.append('%s: %s using hamon-upload (%d visit(s), %d change(s))' % (n, role, r['up_visits'], len(r['up_changes'])))
        if len(r['ips']) >= 3:
            notes.append('%s: %d IPs (%s) - shared or roaming login' % (n, len(r['ips']), ', '.join(sorted(r['ips']))))
        if r['failed']:
            notes.append('%s: %d failed login(s)' % (n, r['failed']))
    idle = [n for uid, u in us.items() for n in [u['login']] if n not in rows or not rows[n]['days'] and not rows[n]['up_visits']]
    idle_admin = [n for n in idle if by_login[n]['role'] == 'Admin' or by_login[n]['admin']]
    for n in idle_admin:
        notes.append('%s: Admin, not seen in %d days (last %s)' % (n, args.days, (by_login[n]['last_seen'] or '-')[:16]))
    if idle:
        print('\nNot seen in %d days: %s' % (args.days, ', '.join('%s (%s)' % (n, by_login[n]['role']) for n in sorted(idle))))
    changes = [(n, c) for n in order for c in rows[n]['up_changes']]
    if changes:
        print('\nhamon-upload changes:')
        for n, c in changes:
            print('  %s  %s' % (c, n))
    boards = [(n, sorted(rows[n]['boards'])) for n in order if rows[n]['boards']]
    if boards:
        print('\nDashboards saved:')
        for n, b in boards:
            print('  %s: %s' % (n, '; '.join(x[:40] for x in b)))
    if refused:
        print('\nhamon-upload refused (no or dead session, one per IP/hour): %d' % refused)
    if notes:
        print('\nRole notes:')
        for x in notes:
            print('  - ' + x)
    first = read_jsonl(EVENTS, 0)[:1]
    if not first or parse(first[0]['t']) > since:
        print('\n(login history starts %s: the recorder keeps it from its first run)' % (first[0]['t'][:10] if first else 'now'))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd', choices=['record', 'report'])
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--db', default=DB)
    ap.add_argument('-v', '--verbose', action='store_true')
    args = ap.parse_args()
    (record if args.cmd == 'record' else report)(args)


if __name__ == '__main__':
    sys.exit(main())
