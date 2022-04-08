function formatGroupAddress(value) {
  const num = parseInt(value)
  return `${(num & 0x7800) >> 11}/${(num & 0x700) >> 8}/${num & 0xff}`
}

exports.formatGroupAddress = formatGroupAddress