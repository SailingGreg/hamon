#! /usr/bin/bash
#
# archive-hamonyml.sh
#
# Config edits leave backup copies beside the live files: hamon.yml.<epoch-ms>
# (restart/templating flow and hamon-upload), hamon.yml.<YYMMDD>, and
# hand-made copies taken before an edit (hamon.yml.bak-<date>-<why>,
# hamon.yml.pre-<why>, dptmappings.txt.<suffix>,
# freshness-thresholds.conf.bak-<date>), plus GA exports that hamon-upload
# replaced (config/<name>.xml.<epoch-ms>). This moves them all into
# config/archive and trims the archive to ~6 months.
#
# Safe to run repeatedly (e.g. from cron). The live files - hamon.yml,
# hamon.yml.template, dptmappings.txt, freshness-thresholds.conf and the
# config/*.xml exports - are never touched.

loc=/home/greg/hamon
archive=$loc/config/archive
keepdays=183			# ~6 months

mkdir -p "$archive"

# hamon.yml.[0-9]*: a digit after "hamon.yml." = epoch-ms or YYMMDD/YYYYMMDD,
# so never .template/.old; *.xml.[0-9]*: only the epoch-ms copies of exports
shopt -s nullglob
moved=0
for f in "$loc"/hamon.yml.[0-9]* "$loc"/hamon.yml.bak-* "$loc"/hamon.yml.pre-* \
         "$loc"/dptmappings.txt.* "$loc"/freshness-thresholds.conf.bak-* \
         "$loc"/config/*.xml.[0-9]*; do
	mv -- "$f" "$archive"/
	moved=$((moved + 1))
done
echo "Moved $moved backup file(s) to $archive"

# trim: drop archived backups older than ~6 months (by modification time)
trimmed=$(find "$archive" -maxdepth 1 -type f \( -name 'hamon.yml.*' -o -name 'dptmappings.txt.*' \
	-o -name 'freshness-thresholds.conf.*' -o -name '*.xml.[0-9]*' \) -mtime +$keepdays -print -delete | wc -l)
echo "Trimmed $trimmed file(s) older than $keepdays days from $archive"

exit 0
