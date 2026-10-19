#!/bin/bash
# unmapped.sh [combined.log ...] - the live GAs hamon still can't store: every
# "UNMAPPED" line in the logs, less the GAs dptmappings.txt now maps (an "@ga"
# rule, or a name rule matching the GA's ETS name), one line per site/GA,
# oldest first seen. Run from the hamon directory.
#   utils/unmapped.sh                   # src/combined.log
#   utils/unmapped.sh src/combined.log*  # include rotated logs (.gz fine)
logs=("$@"); [ ${#logs[@]} -eq 0 ] && logs=(src/combined.log)
mapped=$(grep -oE '^"[^"]+","@[0-9/]+"' dptmappings.txt 2>/dev/null | tr -d '"@' | tr ',' ' ')
zcat -f "${logs[@]}" | sed 's/\x1b\[[0-9;]*m//g' \
  | grep -aE '^warn: UNMAPPED ' \
  | sed -E 's/^warn: UNMAPPED ([^ ]+) ([^ ]+) from ([^:]+): (.*), payload ([^ ]+).*/\1 \2 \3 \5 \4/' \
  | awk -v mapped="$mapped" 'BEGIN { n = split(mapped, m, "\n"); for (i = 1; i <= n; i++) done[m[i]] = 1 }
      { key = $1 " " $2; if (key in done || key in seen) next; seen[key] = 1
        reason = $0; sub(/^([^ ]+ ){4}/, "", reason)
        printf "%-14s %-9s from %-9s payload %-6s %s\n", $1, $2, $3, $4, reason }' \
  | node -e '
      // drop GAs whose ETS name a dptmappings.txt name rule now maps
      const { loadmapping, mapstring } = require("./src/strtodpt")
      const log = console.log; console.log = () => {}; loadmapping("./"); console.log = log
      require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
          const name = line.match(/no DPT for "(.*)"$/)
          if (!name || mapstring(line.split(/ +/)[0], name[1]) === undefined) console.log(line)
      })'
