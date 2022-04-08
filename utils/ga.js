function formatGroupAddress(value) {
  return `${(value & 0x7800) >> 11}/${(value & 0x700) >> 8}/${value & 0xff}`
}

exports.formatGroupAddress = formatGroupAddress