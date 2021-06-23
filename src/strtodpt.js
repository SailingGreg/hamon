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

            //console.log (strs);
            this.lines[this.cnt++] = strs;

        }

        //console.log(this.cnt);
        /*
        for (var l = 0; l < this.cnt; l++ ) {
            //console.log(this.lines[l][0].length);
            if (this.lines[l][0] == 'morgan')
                console.log("Match for morgan");
            console.log("%s, %s, %s", this.lines[l][0], this.lines[l][1], this.lines[l][2]);
        }
        */

    }


    // expand str - use if undefined dpt = strtodpt.expand();
    expand (loc, str) {

        // iterate over the lines
        for (var l = 0; l < this.cnt; l++ ) {
            if (loc.length > 0 && this.lines[l][0] != loc)
                continue;
            //console.log(this.lines[l]);
            if (this.lines[l][1].startsWith("^")) {
                //console.log("Starts with ^");
                // remove "^"
                let t = this.lines[l][1].substring(1);
                if (str.startsWith(t))
                    return this.lines[l][2];
            }
            if (this.lines[l][1].includes(str))
                return this.lines[l][2];
        }

        return undefined;
    }

}

/*
let t = new strtodpt("./");

console.log(t.expand("", "Date "));
console.log(t.expand("morgan", " Boiler"));
console.log(t.expand("", " Room temp"));
console.log(t.expand("", " Test undefined"));
*/

exports.strtodpt = strtodpt;
//export { strtodpt };
