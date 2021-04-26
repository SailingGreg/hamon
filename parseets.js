/*
 * parseetc.js - parse config file and summary active elements
 *
 *
 *
 */

const ets = require('./parsexml');
const fs = require('fs');

//console.log(process.argv);
var fileArg = process.argv[2];
if (fileArg == undefined || fileArg == "") {
    console.log ("usage: %s {filename}", process.argv[1]);
    return 1;
}

if (fs.existsSync("./" + fileArg)) {
    console.log ("Parsing file %s", fileArg);
} else {
    console.log ("File %s doesn't exist", fileArg);
    return 1;
}

// parse the etx xml exmport
let groupAddresses = ets.parsexml("./" + fileArg) || {};

addr = 0;
dpts = 0;
ga = 0;
for (let key in groupAddresses) {
    addr++;
    if (groupAddresses.hasOwnProperty(key)) {
        if (groupAddresses[key].dpt != undefined)
            dpts++;
        console.log(key, groupAddresses[key].dpt,
            groupAddresses[key].name);
        ga++;
    }
}
console.log("%s has %d entries, %d with values and %d DPTs",
 					 fileArg, addr, ga, dpts);

// end of file
