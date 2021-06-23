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

class strtodpt {

    lines = {};
    cnt = 0;
    // initalise - load the mapping strings - dpts = new strtpdpt(loc)
    constructor (loc) {
        //this.lines = {};

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
                strs[3] = "1";
            } else {
                strs[3] = "0";
                //let t = this.lines[l][1].substring(1);
            }

            //console.log (strs);
            this.lines[this.cnt++] = strs;

        }

    }


    // expand str - use if undefined dpt = strtodpt.expand();
    expand (loc, str) {

        // iterate over the lines
        for (var l = 0; l < this.cnt; l++ ) {
            if (loc.length > 0 && this.lines[l][0] != loc)
                continue;
            //console.log(this.lines[l]);
            if (this.lines[l][3] == "1") {
                //console.log("Starts with %s check", str);
                // remove "^"
                //let t = this.lines[l][1].substring(1);
                if (str.startsWith(this.lines[l][1]))
                    return this.lines[l][2];
            } else if (this.lines[l][1].includes(str))
                return this.lines[l][2];
        }

        return undefined;
    }

}

/*
let t = new strtodpt("./");

console.log(t.expand("", "Date ") == "DPT11.001" ? true : false);
console.log(t.expand("morgan", " Boiler") == "DPT1.001" ? true : false);
console.log(t.expand("", " Room temp") == "DPT9.001" ? true : false);
console.log(t.expand("", " Test undefined") == undefined ? true : false);
*/

exports.strtodpt = strtodpt;
//export { strtodpt };
