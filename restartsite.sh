#! /bin/bash
#
# restartsite.sh {site}
#
# takes a site as the argument and touches the xml file and then hamon.yml
# to trigger the restart of an individual site
#

loc=/home/greg/hamon
log=$loc/tmp/restart.log


# note run and user
date >> $log
whoami >> $log

location=$1
if [ "$location" == "" ]; then
	echo "$0 {site}"
	exit 1
fi

site=$location

#echo "Restarting $site"
echo "Manually restarting $site" >> $log
echo "Restarting the site: $site"

# write it to the named pipe so hamon can action
#echo $site > $loc/tmp/kpipe

# check the site name in the configuration file
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

echo "Restart triggered"

# tidyup - remote process file?
#if [ -f $site.$$ ]; then
	#rm $site.$$
#fi

exit 0
