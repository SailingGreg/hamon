#
# program to monitor for ip address changes for routers
#
#
#
#
#

import os
import socket
import time
import signal
import logging
from datetime import datetime
from datetime import timedelta


fname = "chkdns.txt"
lname = "chkdns.out"
hosts = [];

def handleSignal(signalNumber, frame):
    print('Received:', signalNumber);
    logging.warning(f"Received signal {signalNumber}, exiting");
    exit(0);

# end of handle signal

# open and parse the file chkdns.txt based on "." or env path
def init():
    global fname;
    global lname;
    cnt = 0;

    home = os.environ.get("HOME");
    if (home != None):
        fname = home + "/hamon/utils/" + fname;
        lname = home + "/hamon/utils/" + lname;
    else:
        fname = "./" + fname;
        lname = "./" + lname;

    logging.basicConfig(filename=lname, level=logging.INFO);
    #logging.basicConfig(filename=lname, encoding='utf-8', level=logging.INFO);

    try:
        f = open(fname, "r");
    except:
        print ("File doesnt't exist", fname);


    lines = f.readlines();

    for line in lines:
        line = line.strip('\n');
        if (line[0] == '#' or len(line) == 0):
            continue
        #print(line);
        host = {'dns': line, 'addr': 0, 'time': 0}
        hosts.append(host);
        cnt = cnt + 1;

    #for host in hosts:
    #    print(host);
    return cnt;
# end of init()


# main

# set handlers for interrupts
signal.signal(signal.SIGHUP, handleSignal);
signal.signal(signal.SIGINT, handleSignal);
signal.signal(signal.SIGTERM, handleSignal);

cnt = init();
err = False;

print (f"Checking for {cnt} locations");
logging.info(f"Checking for {cnt} locations");
while (True):
    for host in hosts:
        hostname = host['dns'];
        try:
            addrinfo = socket.getaddrinfo(hostname, 80);
            err = False;
        except:
            err = True;
            exc_type, exc_value, exc_traceback = sys.exc_info();
            lines = traceback.format_exception(exc_type, exc_value, \
                                                            exc_traceback);
            logging.error(f"Error re DNS query {lines}");


        if (err == False): # if we have an address
            addr = addrinfo[0][4][0];
           
            now = datetime.now()

            #print (now);
            #current_time = now.strftime("%D %H:%M:%S")
            #print("Current Time =", current_time)

            if (host['addr'] == 0): # add
                now = time.time();
                cdate = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now));
                #print ("Resolved ", host['dns'], addr, cdate);
                logging.info(f"Resolved {host['dns']}, {addr}, {cdate}");
                host['addr'] = addr;
                host['time'] = now;
            elif (host['addr'] != addr): # it has changed
                now = time.time();
                diff = now - host['time']
                elapsed = str(timedelta(seconds=diff));
                cdate = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now));
                #print("DNS change ", cdate, host['dns'],
                                          #host['addr'], addr, elapsed);
                logging.warning(f"DNS change {cdate}: {host['dns']}, \
                                        {host['addr']} -> {addr}, {elapsed}");
                host['addr'] = addr;
                host['time'] = now;

            # if not err

    time.sleep (60); # every 5 mins is 300

# end of while(true)
