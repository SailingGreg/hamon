#! /usr/bin/bash
#
# backup-pull.sh - keep an off-server copy of the prod backups (runs on staging)
#
# Pulls the nightly influx.* tarballs made by hamon-backup2 (23:30 on prod)
# and keeps about a week of them here. It pulls rather than prod pushing, so
# prod cannot touch these copies. On prod this key is restricted in
# ~greg/.ssh/authorized_keys to the read-only forced command:
#   from="10.107.91.3",command="/usr/local/sbin/hamon-backup-rsync",restrict ssh-ed25519 ...
#
# cron (staging):  0 2 * * * /home/greg/hamon/backup-pull.sh >> /home/greg/hamon/tmp/backup-pull.log 2>&1

# over the internal network (eth1), so it does not depend on prod's public routing
SRC=greg@10.107.91.4:/var/opt/hamon
DEST=/home/greg/backups/home.monitor-software.com
BK=$DEST/backups
KEY=/home/greg/.ssh/id_backup_pull
KEEP=7		# days; with -mtime this keeps 8 nightly copies

mkdir -p "$BK" || exit 1
echo "$(date '+%F %T') pull start"

# the forced command only allows /var/opt/hamon itself, so filter to backups/influx.*
# --fuzzy lets yesterday's tarball be the delta basis for today's new name
rsync -a --fuzzy --partial --include='backups/' --include='backups/influx.*' --exclude='*' \
	-e "ssh -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new" "$SRC/" "$DEST/"
rc=$?
if [ $rc -ne 0 ]; then
	echo "$(date '+%F %T') rsync failed (rc=$rc), not pruning" >&2
	exit $rc
fi

# only prune once a fresh copy has landed
if [ -n "$(find "$BK" -maxdepth 1 -name 'influx.*' -mtime -1 -print -quit)" ]; then
	find "$BK" -maxdepth 1 -name 'influx.*' -mtime +$KEEP -print -delete
else
	echo "$(date '+%F %T') no backup newer than a day, not pruning" >&2
	exit 1
fi
echo "$(date '+%F %T') pull done: $(ls "$BK" | grep -c '^influx\.') copies, $(du -sh "$BK" | cut -f1)"
