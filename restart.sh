#! /bin/bash
#
# restart.sh {site}
#

loc=/home/greg/hamon
log=$loc/tmp/restart.log

# note the json passed on stdin
# should be $$ for process file so unique
# comment when debugging
if [ -t 0 ] && [ -n "$TERM" ]; then
	echo "Running from a terminal" >> $log
else
	echo "Not running from a terminal" >> $log
fi 
cat > $loc/tmp/alert.json

# note the date and the user
date >> $log
whoami >> $log

# extract the location from the args
location=`sed -n 's|^.*"tags":{"location":"\([a-z1-9].*\)"}.*$|\1|p' < $loc/tmp/alert.json`

# do we have a location
if [ "$location" == "" ]; then
	echo "usage: $0 {site}"
	echo "No location, exiting"  >> $log
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
# number of lines increased with addition of hapi to configuration file
config=`grep -A 9 " name: $site" $loc/hamon.yml | grep config | awk  '{print $2}'`
addr=`grep -A 9 " name: $site" $loc/hamon.yml | grep dns | awk  '{print $2}'`
enabled=`grep -A 9 " name: $site" $loc/hamon.yml | grep enabled | awk  '{print $2}'`

# Guard to note if site has disabled
WHO=`whoami`
if [ "$enabled" == "false" ]; then
	echo "Exiting as $site disabled - $WHO" >> $log
	# restart kapacitor to stop alerts
	# systemctl restart kapacitor
	exit 0
fi

# is this a container that is "172."
if [[ $addr == 172.* ]]; then
	cont=true

	# need to restart the right container so we need a name mapping
	# and we based this on the container be the name of the location

	echo "Restarting docker for $site" >> $log
	docker restart $site
	sleep 10 # allow time for reestablishment of vpn
	#exit 0
fi

#echo "Restarting $site"
echo "Restarting $site $config $addr $cont" >> $log

# ADDED FOR DEBUG
#exit 0

# write it to the named pipe so hamon can action
echo $site > $loc/tmp/kpipe


# restart handled in service.js
#echo "Exiting and not touching $site xml" > $loc/tmp/kpipe
echo "Exiting and not touching $site xml" >> $log
exit 0

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
