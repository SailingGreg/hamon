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
//let cnt = 0;

function loadmapping(loc) {

    // initalise - load the mapping strings - dpts = new strtpdpt(loc)
    //constructor (loc) {
        //this.lines = [];

        // add try
        console.log(loc + fname);
        let data = fs.readFileSync(loc + fname, 'utf-8');

        let ll = data.split('\n');
        //console.log (ll); // this is a Buffer()
        //let line = "";
        for (const line of ll) {
            // skip comments or null lines
            //console.log (line);
            if ((line[0] == "#") || (line.length == 0)) continue;

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

        //console.log (this.lines);
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



module.exports.mapstring = mapstring;
module.exports.loadmapping = loadmapping;
//exports.strtodpt = strtodpt;
//export { strtodpt };
