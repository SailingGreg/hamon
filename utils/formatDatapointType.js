const dptRegExp = new RegExp('DPS?T\\-(\\d+)(\\-(\\d+))?');

function formatDatapointType(value) {
  let dpt
  if (value !== undefined) {
    var match = dptRegExp.exec(value);
    if (!match) {
      console.log("Unrecognized datapoint %s", value);
    } else {
      dpt = 'DPT' + match[1] + (match[3] !== undefined ? '.' + match[3].padStart(3, 0) : '');
    }
  }
  return dpt
}

exports.formatDatapointType = formatDatapointType