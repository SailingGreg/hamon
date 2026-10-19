#!/bin/bash
# unmapped.sh [combined.log ...] - the live GAs hamon still can't store: every
# "UNMAPPED" line in the logs, less the GAs dptmappings.txt now maps (an "@ga"
# rule, or a name rule matching the GA's ETS name), one line per site/GA,
# oldest first seen, with every payload logged for it (and "(6-bit)" or
# "(N bytes)" where hamon logged that). Run from the hamon directory.
#   utils/unmapped.sh                   # src/combined.log
#   utils/unmapped.sh src/combined.log*  # include rotated logs (.gz fine)
logs=("$@"); [ ${#logs[@]} -eq 0 ] && logs=(src/combined.log)
mapped=$(grep -oE '^"[^"]+","@[0-9/]+"' dptmappings.txt 2>/dev/null | tr -d '"@' | tr ',' ' ')
zcat -f "${logs[@]}" | sed 's/\x1b\[[0-9;]*m//g' \
  | grep -aE '^warn: UNMAPPED ' \
  | sed -E 's/ \{"service".*//; s/^warn: UNMAPPED ([^ ]+) ([^ ]+) from ([^:]+): (.*), payload (.*)$/\1\t\2\t\3\t\5\t\4/' \
  | awk -F'\t' -v mapped="$mapped" 'BEGIN { n = split(mapped, m, "\n"); for (i = 1; i <= n; i++) done[m[i]] = 1 }
      { key = $1 " " $2; if (key in done) next
        sub(/ \([0-9]+ GAs - no more logged until restart\)$/, "", $4)
        if ($5 ~ /^value [0-9]+ of /) { if (key in seen && index(vals[key], " " $4 ";") == 0) vals[key] = vals[key] " " $4 ";"; next }
        if (key in seen) next
        seen[key] = 1; order[++k] = key; line[key] = $0; vals[key] = " " $4 ";" }
      END { for (i = 1; i <= k; i++) { split(line[order[i]], f, "\t"); v = vals[order[i]]; gsub(/;/, "", v)
              printf "%-14s %-9s from %-9s payload%s  %s\n", f[1], f[2], f[3], v, f[5] } }' \
  | node -e '
      // drop GAs whose ETS name a dptmappings.txt name rule now maps
      const { loadmapping, mapstring } = require("./src/strtodpt")
      const log = console.log; console.log = () => {}; loadmapping("./"); console.log = log
      require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
          const name = line.match(/no DPT for "(.*)"$/)
          if (!name || mapstring(line.split(/ +/)[0], name[1]) === undefined) console.log(line)
      })'
