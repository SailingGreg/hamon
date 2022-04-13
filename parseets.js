/*
 * parseetc.js - parse config file and summary active elements
 *
 *
 *
 */

const fs = require('fs');
const { etsProjectParser } = require('./utils/etsProjectParser');

//console.log(process.argv);
var fileArg = process.argv[2];
var passwordArg = process.argv[3];
if (fileArg == undefined || fileArg == "") {
    console.log("usage: %s {filename}", process.argv[1]);
    process.exit(1)
}

if (fs.existsSync("./" + fileArg)) {
    console.log("Parsing file %s", fileArg);
} else {
    console.log("File %s doesn't exist", fileArg);
    process.exit(1)
}

etsProjectParser("./" + fileArg, passwordArg).then((project) => {
    addr = 0;
    dpts = 0;
    ga = 0;
    const groupAddresses = project.groupAddresses
    for (let key in groupAddresses) {
        addr++;
        if (groupAddresses.hasOwnProperty(key)) {
            //if (groupAddresses[key].dpt != undefined)
            if (groupAddresses[key].datapointType != undefined)
                dpts++;
            // console.log(key, groupAddresses[key].dpt,
            //     groupAddresses[key].name);
            ga++;
        }
    }

    outputFile = fileArg.substring(0, fileArg.lastIndexOf('.')) + ".json";
    fs.writeFile(outputFile, JSON.stringify(groupAddresses), err => {
        if (err) {
            throw err;
        }
        console.log('Address data is saved to ' + outputFile + ' file');
    });

    console.log("%s has %d entries, %d with values and %d DPTs", fileArg, addr, ga, dpts);
})

// end of file
