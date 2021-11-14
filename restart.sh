#! /bin/bash
#
# restart.sh {site}
#

loc=/home/greg/hamon
log=$loc/tmp/restart.log

# note the json passed on stdin
# should be $$ for process file so unique
cat > $loc/tmp/alert.json

# note run and user
date >> $log
whoami >> $log

# extract the location
location=`sed -n 's|^.*"tags":{"location":"\([a-z]*\)"}.*$|\1|p' < $loc/tmp/alert.json`

if [ "$location" == "" ]; then
	echo "$0 {site}"
	exit 1
fi

site=$location

#echo "Restarting $site"
echo "Restarting $site" >> $log

# write it to the named pipe so hamon can action
echo $site > $loc/tmp/kpipe

cnt=`grep -c -m 1 $site $loc/hamon.yml`

#echo $cnt
if [ $cnt -eq 0 ]; then
	echo "site $site not defined"
	exit 1
fi

# could grep the hamon.yml file and then fail back
#xml=`grep "$site.*xml" $loc/hamon.yml | awk '{print $2}'`

# do site -> configuration file mapping
xml=`grep $site $loc/sitesxml.conf | awk '{print $2}'`

if [ "$xml" == "" ]; then
	echo "There is no xml file for $site"
	exit 1
fi

echo "Touching $loc/$xml" >> $log
if [ -f $loc/$xml ]; then
	touch $loc/$xml
else
	echo "The xml file $xml doesn't exist for $site"
	exit 1
fi

# and trigger restart
echo "Triggering restart" >> $log
touch $loc/hamon.yml

# tidyup - remote process file?
if [ -f $site.$$ ]; then
	rm $site.$$
fi

exit 0
