/*
 *
 *
 *
 *
 *
 *
 */

const fs = require('fs');

let fname = "dptmappings.txt";
let lines = [];
let addrRules = []; // "@<ga>" rules, see mapaddress()
//let cnt = 0;

// split a mapping line on commas outside double quotes and strip the quotes,
// so an "@" rule's name can contain commas
function splitQuoted(line) {
    let fields = [];
    let cur = "";
    let quoted = false;
    for (const ch of line) {
        if (ch == '"') quoted = !quoted;
        else if (ch == ',' && !quoted) { fields.push(cur.trim()); cur = ""; }
        else cur += ch;
    }
    fields.push(cur.trim());
    return fields;
}

// load the rules, replacing any loaded before: each site start reloads the
// file (so a kpipe picks up an edit), and with every site in one thread
// (threads: false) appending would add another copy of every rule each time.
// site: the site loading them, for the hamon.log line
function loadmapping(loc, site) {

        // add try
        let data = fs.readFileSync(loc + fname, 'utf-8');
        lines = [];
        addrRules = [];

        let ll = data.split('\n');
        //console.log (ll); // this is a Buffer()
        //let line = "";
        for (const line of ll) {
            // skip comments or null lines
            //console.log (line);
            if ((line[0] == "#") || (line.length == 0)) continue;

            // "location","@<ga>",<dpt>[,override[,"name"]] - an exact group
            // address; site-specific, so a location is required. With a dpt
            // it also adds a GA the ETS export doesn't have
            let fields = splitQuoted(line.replace(/\r$/, ""));
            if (fields.length > 2 && fields[1].startsWith("@")) {
                if (fields[0].length == 0) {
                    console.log("dptmappings: ignoring @ rule without a location: " + line);
                    continue;
                }
                addrRules.push({
                    loc: fields[0],
                    ga: fields[1].substring(1),
                    dpt: fields[2] || undefined,
                    override: fields[3] == "override",
                    name: fields[4] || undefined
                });
                continue;
            }

            //line.replace(/'/g, "");

            // split the line into array
            let strs = line.replace(/"/g, "").split(",");

            // set 'start' flag
            //console.log("Parsing %s", strs[1]);
            if (strs[1].startsWith("^")) {
                // remove "^"
                strs[1] = strs[1].substring(1);
                strs.push("1");
                //strs[3] = "1";
            } else {
                strs.push("0");
                //strs[3] = "0";
            }

            //console.log (strs);
            lines.push(strs);
            //cnt++;

        }

        console.log(`${site ? `[${site}] ` : ''}${loc + fname}: ${lines.length} name rules, ${addrRules.length} address rules`);
}


    // mapstr str - use if undefined dpt = strtodpt.mapstr();
function mapstring (loc, str) {

        //console.log(lines);
        // iterate over the lines
        for (let line of lines) {

            // if there a 'scope' validate
            if (line[0].length > 0 && loc.length > 0 && line[0] != loc)
                continue;

            //console.log(line, str);
            if (line[3] == "1") {
                //console.log("Starts with %s check", str);
                if (str.startsWith(line[1])) {
                    //console.log ("Match start: ", line[2]);
                    return line[2];
                }
            //} else if (line[1].includes(str)) {
            } else {
                //console.log("Includes %s check", str);
                if (str.includes(line[1])) {
                    //console.log ("Match includes: ", line[2]);
                    return line[2];
                }
            }
        }

        return undefined;
}



/*
//let t = new strtodpt("./");
//let t = new strtodpt("./");
loadmapping("./");

console.log(mapstring("", "Date XX") == "DPT11.001" ? true : false);
console.log(mapstring("morgan", "XX Boiler") == "DPT1.001" ? true : false);
console.log(mapstring("", "XX Room temp") == "DPT9.001" ? true : false);
console.log(mapstring("", " Test undefined") == undefined ? true : false);
*/



// rule for an exact group address at this location, or undefined. Its dpt
// fills an undefined ETS dpt, or replaces a defined one when 'override' is
// set; its name, if any, replaces the ETS name
function mapaddress (loc, ga) {
    return addrRules.find(rule => rule.loc == loc && rule.ga == ga);
}

// a location's exact-address rules
function addressRules (loc) {
    return addrRules.filter(rule => rule.loc == loc);
}

module.exports.mapstring = mapstring;
module.exports.mapaddress = mapaddress;
module.exports.addressRules = addressRules;
module.exports.loadmapping = loadmapping;
//exports.strtodpt = strtodpt;
//export { strtodpt };
