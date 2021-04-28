# hamon
Home Automation Monitor

This is small project that use the knx.js stack to access and display
KNX data via KNXnet/IP Router - in this case ha-test.dyndns.org

Data is written to influxDB and then Grafana is used for display

# To run test
node worker.js

# To tun ha-mon.js with multi-thread
node src