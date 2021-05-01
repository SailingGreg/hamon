# script to list knx entries
#

echo "Listing knx2 entries in hamon database"
influx -execute 'SELECT count(*) FROM knx2' -database="hamon"


