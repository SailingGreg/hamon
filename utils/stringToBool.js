const stringToBool = str => {
  return Boolean(str && (str.match(/^true$/i) || str.match(/^enabled$/i) || str === '1'))
}

exports.stringToBool = stringToBool
