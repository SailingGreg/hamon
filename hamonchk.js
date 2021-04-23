//
// hamonchk.js - parse the configure file and check
//

const yaml = require('js-yaml');
const fs   = require('fs');
var dnsSync = require('dns-sync');

const hamonConfig = "hamon.yml"; // the configuration file - add location

// check if the config file exists
try {
  if (fs.existsSync(hamonConfig)) {
    //file exists
    console.log("Configuration file %s exists, parsing ...", hamonConfig);
  } else {
    console.log("Configuration file %s doesn't exist", hamonConfig);
    return false;
  }
} catch(err) {
  console.error(err)
  return false;
}


//console.log("Parsing file %s", hamonConfig);
// Get document, or throw exception on error
try {
  const doc = yaml.load(fs.readFileSync('hamon.yml', 'utf8'));
  //console.log(doc);

  //console.log(doc["locations"]);
  //console.log ("There are %j locations", doc["locations"]);
  
  cnt = 0;
  console.log ("These are the locations");
  for (loc in doc["locations"]) {
     cnt = cnt + 1;
     install = doc["locations"][loc]
     console.log("\t %s %s %s %d", loc, install['name'], install['dns'], install['port']);
  }
  console.log ("There are %d locations in the file", cnt);
  //console.log ("There are %d locations in the file", Object.keys(doc["locations"]).lenght);

  for (loc in doc["locations"]) {
      //console.log(loc);
      install = doc["locations"][loc]
      //console.log(loc, install['name'], install['dns'], install['port']);

      // check dns entries
      dnsEntry = install['dns']
      etsEntry = install['config']
      console.log("Checking location %s -> %s", install['name'], dnsEntry);
      ipaddr = dnsSync.resolve(dnsEntry);
      if (ipaddr != null) {
          console.log("\tEntry resolved to %s", ipaddr);
      } else {
          console.log("\tEntry %s did not resolve and is invalid", dnsEntry);
      }
      // check the ETS XML file
      if (fs.existsSync(etsEntry)) {
        //file exists
        console.log("\tETS export file %s exists", etsEntry);
      } else {
        console.log("\tETS export file %s doesn't exist", etsEntry);
      }
   }
} catch (err) {
  console.log(err);
}

// end of file
