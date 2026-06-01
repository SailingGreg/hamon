#! /usr/bin/bash
#
# archive-hamonyml.sh
#
# The restart/templating flow leaves timestamped backups of the live config
# (hamon.yml.<epoch-ms> and older hamon.yml.<YYMMDD>) in the hamon root.
# This moves them into config/archive and trims the archive to ~6 months.
#
# Safe to run repeatedly (e.g. from cron). The live hamon.yml is never touched.

loc=/home/greg/hamon
archive=$loc/config/archive
keepdays=183			# ~6 months

mkdir -p "$archive"

# move timestamped hamon.yml.* backups out of the root.
# the glob requires a digit after "hamon.yml." so it matches the epoch-ms
# and YYMMDD/YYYYMMDD backups but never the live hamon.yml or .template/.old.
shopt -s nullglob
moved=0
for f in "$loc"/hamon.yml.[0-9]*; do
	mv -- "$f" "$archive"/
	moved=$((moved + 1))
done
echo "Moved $moved hamon.yml.* file(s) to $archive"

# trim: drop archived backups older than ~6 months (by modification time)
trimmed=$(find "$archive" -maxdepth 1 -type f -name 'hamon.yml.*' -mtime +$keepdays -print -delete | wc -l)
echo "Trimmed $trimmed file(s) older than $keepdays days from $archive"

exit 0
