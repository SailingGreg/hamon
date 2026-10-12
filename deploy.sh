#!/bin/bash
# Deploy a branch to a hamon server and optionally restart named site workers.
# Usage: ./deploy.sh <prod|staging> <branch> [site ...]
#   Moves ~/hamon on the server to origin/<branch>. It refuses if tracked files
#   there have local changes. Each named site is then restarted through the
#   kpipe, one at a time, and the script waits for its "Connected" line.
#   Without sites only the checkout changes: workers pick it up on their next
#   restart.

set -e

case "$1" in
    prod)    HOST="greg@home.monitor-software.com" ;;
    staging) HOST="greg@home-dev.monitor-software.com" ;;
    *) echo "Usage: $0 <prod|staging> <branch> [site ...]"; exit 1 ;;
esac
BRANCH="$2"
[ -n "$BRANCH" ] || { echo "Usage: $0 <prod|staging> <branch> [site ...]"; exit 1; }
shift 2

ssh "$HOST" "cd ~/hamon &&
    if [ -n \"\$(git status --porcelain --untracked-files=no)\" ]; then
        echo 'Tracked files have local changes - not deploying:'; git status --short --untracked-files=no; exit 1
    fi &&
    git fetch -q origin &&
    git checkout -q -B '$BRANCH' 'origin/$BRANCH' &&
    echo \"\$(hostname): now on \$(git log --oneline -1)\""

for site in "$@"; do
    echo "Restarting $site ..."
    ssh "$HOST" "cd ~/hamon &&
        [ -p tmp/kpipe ] || { echo 'no tmp/kpipe - is ha-mon running here?'; exit 1; }
        start=\$(wc -l < src/combined.log)
        echo '$site' > tmp/kpipe
        for i in \$(seq 60); do
            sleep 2
            if tail -n +\$start src/combined.log | grep -a -q 'Connected - $site '; then
                tail -n +\$start src/combined.log | grep -a 'Connected - $site \|GA for $site:' | sed -E 's/\x1b\[[0-9;]*m//g'
                exit 0
            fi
        done
        echo '$site: no Connected line after 2 minutes - check src/combined.log'; exit 1"
done
