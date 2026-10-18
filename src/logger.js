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
        filename: __dirname + '/error.log',
        level: 'error'
      }),
      new winston.transports.File({ filename: __dirname + "/combined.log" })
    ]
  })
  
  // a site's own logger: every line it writes carries {"site": name}, so a
  // site's lines can be told apart however the sites run (a worker each, or all
  // in one thread). The message text is unchanged, so greps of it still work
  logger.siteLogger = (name) => logger.child({ site: name })

  module.exports = logger
