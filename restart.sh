#! /bin/bash
#
# restart.sh {site}
#

loc=/home/greg/hamon
log=$loc/tmp/restart.log

# note the json passed on stdin
# should be $$ for process file so unique
# comment when debugging
cat > $loc/tmp/alert.json

# note run and user
date >> $log
whoami >> $log

# extract the location from the args
location=`sed -n 's|^.*"tags":{"location":"\([a-z1-9]*\)"}.*$|\1|p' < $loc/tmp/alert.json`

# do we have a location
if [ "$location" == "" ]; then
	echo "$0 {site}"
	exit 1
fi

site=$location

# and is the location defined
cnt=`grep -c -m 1 $site $loc/hamon.yml`
if [ $cnt -eq 0 ]; then
	echo "Site $site not defined" >> $log
	echo "site $site not defined"
	exit 1
fi

# find the xml file and address from hamon.yml
config=`grep -A 8 " name: $site" $loc/hamon.yml | grep config | awk  '{print $2}'`
addr=`grep -A 8 " name: $site" $loc/hamon.yml | grep dns | awk  '{print $2}'`

# is this a container that is "172."
if [[ $addr == 172.* ]]; then
	cont=true

	# need to restart the right container so we need a name mapping
	# and we based this on the container be the name of the location

	#docker restart $site
	#exit 0
fi

#echo "Restarting $site"
echo "Restarting $site $config $addr $cont" >> $log

# ADDED FOR DEBUG
#exit 0

# write it to the named pipe so hamon can action
echo $site > $loc/tmp/kpipe



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
