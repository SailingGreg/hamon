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
        const rule = maprule(loc, str);
        return rule === undefined ? undefined : rule.dpt;
}

// the first name rule that matches a GA name at this location, as
// { loc, pattern, dpt } (pattern with its "^" for starts-with), or undefined
function maprule (loc, str) {

        // iterate over the lines
        for (let line of lines) {

            // if there a 'scope' validate
            if (line[0].length > 0 && loc.length > 0 && line[0] != loc)
                continue;

            if (line[3] == "1" ? str.startsWith(line[1]) : str.includes(line[1]))
                return { loc: line[0], pattern: (line[3] == "1" ? "^" : "") + line[1], dpt: line[2] };
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

// the dptmappings lines a site uses - its own and the shared ("") ones - so
// service.js can restart just the sites an edit affects. '' if no file
function mappingSignature (loc, site) {
    let data
    try { data = fs.readFileSync(loc + fname, 'utf-8') } catch (e) { return '' }
    return data.split('\n').map(l => l.replace(/\r$/, ''))
        .filter(l => l.length > 0 && l[0] != '#')
        .filter(l => { const owner = splitQuoted(l)[0]; return owner == '' || owner == site })
        .join('\n');
}

// a location's exact-address rules
function addressRules (loc) {
    return addrRules.filter(rule => rule.loc == loc);
}

module.exports.mapstring = mapstring;
module.exports.maprule = maprule;
module.exports.mapaddress = mapaddress;
module.exports.addressRules = addressRules;
module.exports.mappingSignature = mappingSignature;
module.exports.loadmapping = loadmapping;
//exports.strtodpt = strtodpt;
//export { strtodpt };
