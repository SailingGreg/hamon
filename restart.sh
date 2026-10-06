#! /bin/bash
#
# restart.sh {site}
#
# Called by kapacitor with the alert JSON on stdin. Recovers a stale site:
#   * container sites (hamon.yml `dns: 172.*`) - restart the docker container that
#     holds that IP, then re-init hamon's connection via the kpipe
#   * standard sites - re-init hamon's connection via the kpipe
#
# Containers are resolved by IP, not by name: container names can differ from site
# names (different spelling or case, or two sites sharing one container). Same
# approach as freshness-detector.sh.
#

loc=${HAMON:-/home/greg/hamon}
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

# extract the location from the args (any site name: mixed case, digits, _ and -)
location=`sed -n 's|^.*"tags":{"location":"\([^"]*\)"}.*$|\1|p' < $loc/tmp/alert.json`

# do we have a location
if [ "$location" == "" ]; then
	echo "usage: $0 {site}"
	echo "No location, exiting: `head -c 200 $loc/tmp/alert.json`" >> $log
	exit 1
fi

site=$location

# the hamon.yml block for exactly this site (not a prefix match: site vs site-2)
block=`grep -A 9 -E "^ +name: ${site}\$" $loc/hamon.yml`

# and is the location defined
if [ "$block" == "" ]; then
	echo "Site $site not defined" >> $log
	echo "site $site not defined"
	exit 1
fi

# find the xml file and address from hamon.yml
# number of lines increased with addition of hapi to configuration file
config=`echo "$block" | grep -m 1 " config:" | awk '{print $2}'`
addr=`echo "$block" | grep -m 1 " dns:" | awk '{print $2}'`
enabled=`echo "$block" | grep -m 1 " enabled:" | awk '{print $2}'`

# Guard to note if site has disabled
WHO=`whoami`
if [ "$enabled" == "false" ]; then
	echo "Exiting as $site disabled - $WHO" >> $log
	# restart kapacitor to stop alerts
	# systemctl restart kapacitor
	exit 0
fi

# container that holds a given IP (running or stopped); "" if none
container_for() {
	local ip=$1 id cip
	for id in `docker ps -aq 2>/dev/null`; do
		for cip in `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' $id 2>/dev/null`; do
			if [ "$cip" == "$ip" ]; then
				docker inspect -f '{{.Name}}' $id | sed 's#^/##'
				return 0
			fi
		done
	done
	return 1
}

cont=false

# is this a container that is "172."
if [[ $addr == 172.* ]]; then
	cont=true
	name=`container_for $addr`

	if [ "$name" == "" ]; then
		# a --rm container that exited is gone; docker restart cannot bring it back
		echo "ERROR: no container holds $addr for $site - recreate it from its vpn/*.sh script" >> $log
	else
		echo "Restarting docker container $name for $site ($addr)" >> $log
		if out=`docker restart $name 2>&1`; then
			sleep 10 # allow time for reestablishment of vpn
		else
			echo "ERROR: docker restart $name failed: $out" >> $log
		fi
	fi
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
