const winston = require('winston')

// create the logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.splat(),
      winston.format.simple()
    ),
    defaultMeta: { service: 'hamon' },
    transports: [
      //
      // - Write all logs with level `error` and below to `error.log`
      // - Write all logs with level `info` and below to `combined.log`
      //
      new winston.transports.File({
        filename: __dirname + '/../error.log',
        level: 'error'
      }),
      new winston.transports.File({ filename: __dirname + "/../combined.log" })
    ]
  })
  
  module.exports = logger
