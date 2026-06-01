#!/usr/bin/env bash
#
# influx-console.sh [--check] [host]
#
# Opens an SSH tunnel so the InfluxDB console/API (which is bound to localhost on
# the server) is reachable in your browser at http://localhost:8086.
# Run this on YOUR machine (Mac/Pi) - needs key-based ssh access as greg.
#
#   ./influx-console.sh                          # tunnel to prod, then browse http://localhost:8086
#   ./influx-console.sh home-dev.monitor-software.com   # tunnel to a specific host
#   ./influx-console.sh --check [host]           # validate the tunnel + influx health, then close
#
# Ctrl-C closes the tunnel. The tunnel keeps working after influxd is bound to
# 127.0.0.1 (ssh reaches the server's own localhost).

set -uo pipefail

LPORT=8086                                   # local port you browse
RPORT=8086                                   # influxd port on the server
SSHUSER=greg
DEFAULT_HOST=home.monitor-software.com

CHECK=0
[ "${1:-}" = "--check" ] && { CHECK=1; shift; }
HOST="${1:-$DEFAULT_HOST}"

SSH_OPTS=(-o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ConnectTimeout=10)

# is the local port already taken?
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$LPORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Local port $LPORT is already in use - close what's using it or change LPORT." >&2
  exit 1
fi

if [ "$CHECK" -eq 1 ]; then
  echo "Validating tunnel to $SSHUSER@$HOST ..."
  if ! ssh -f -N "${SSH_OPTS[@]}" -L "$LPORT:localhost:$RPORT" "$SSHUSER@$HOST"; then
    echo "FAIL: could not open the tunnel (ssh/auth/port)." >&2; exit 1
  fi
  pid=$(pgrep -f "ssh.*-L $LPORT:localhost:$RPORT.*$HOST" | head -1)
  sleep 1
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$LPORT/health" 2>/dev/null)
  body=$(curl -s "http://localhost:$LPORT/health" 2>/dev/null)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  if [ "$code" = "200" ]; then
    echo "OK: influxd reachable through the tunnel (http://localhost:$LPORT/health -> 200)"
    echo "    $body"
    exit 0
  fi
  echo "FAIL: http://localhost:$LPORT/health returned HTTP ${code:-000}" >&2
  exit 1
fi

echo "Tunnel up: http://localhost:$LPORT  ->  $SSHUSER@$HOST:$RPORT (influxd console + API)"
echo "Open http://localhost:$LPORT in your browser. Ctrl-C to close."
exec ssh -N "${SSH_OPTS[@]}" -L "$LPORT:localhost:$RPORT" "$SSHUSER@$HOST"
