# script to list knx entries
#

echo "Listing knx entries in hamon database"
influx -execute 'SELECT * FROM knx' -database="hamon"


