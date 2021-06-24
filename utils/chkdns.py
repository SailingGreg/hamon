#
# program to monitor for ip address changes for routers
#
#
#
#
#

import socket
import time
from datetime import datetime
from datetime import timedelta


hosts = [{ 'dns': "ha-test.pergamentum.com", 'addr': 0, 'time': 0 },
        { 'dns': "ha-office.dyndns.org", 'addr': 0, 'time': 0 },
        { 'dns': "ha-foxways.dyndns.org", 'addr': 0, 'time': 0 },
        { 'dns': "ha-macnamara.dyndns.org", 'addr': 0, 'time': 0 },
        { 'dns': "greig.dyndns.tv", 'addr': 0, 'time': 0 },
        { 'dns': "ha-hardisty.dyndns.org", 'addr': 0, 'time': 0 },
        { 'dns': "bemerton.auto-home.co.uk", 'addr': 0, 'time': 0 },
        { 'dns': "ha-rimer.dyndns.org", 'addr': 0, 'time': 0 },
        { 'dns': "69ec.dyndns.org", 'addr': 0, 'time': 0 },
        { 'dns': "ha-falconwood.dyndns.org", 'addr': 0, 'time': 0 },
        { 'dns': "alexbrown.dyndns-remote.com", 'addr': 0, 'time': 0 } ]

while (True):
    for host in hosts:
        hostname = host['dns'];
        addrinfo = socket.getaddrinfo(hostname, 80);

        addr = addrinfo[0][4][0];
       
        now = datetime.now()

        #print (now);
        #current_time = now.strftime("%D %H:%M:%S")
        #print("Current Time =", current_time)

        if (host['addr'] == 0): # add
            now = time.time();
            cdate = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now));
            print ("Resolved ", host['dns'], addr, cdate);
            host['addr'] = addr;
            host['time'] = now;
        elif (host['addr'] != addr): # it has changed
            now = time.time();
            diff = now - host['time']
            elapsed = str(timedelta(seconds=diff));
            cdate = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now));
            print("DNS change ", cdate, host['dns'],
                                        host['addr'], addr, elapsed);
            host['addr'] = addr;
            host['time'] = now;

        #print(addr);

    time.sleep (300); # every 5 mins

# end of while(true)
