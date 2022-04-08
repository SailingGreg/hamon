var fs = require('fs')
var DecompressZip = require('decompress-zip')
var sax = require('sax')
var { stringToBool } = require('./stringToBool.js')

function cleanWorkdir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const etsProjectParser = async function (etsProjectFilePath, workdir = '.workfolder') {
  // Create a function wide context
  const self = {}

  // Initialisation function
  const initEtsProjectParser = async (etsProjectFilePath, workdir) => {
    self.etsProjectFilePath = etsProjectFilePath
    self.workdir = workdir
    self.projectFolderPath = null

    // The parsed project will be stored here
    self.project = {
      groupAddresses: []
    }

    // Clean workfolder
    cleanWorkdir(workdir)

    // Unzip the stream into workdir
    return unzip()
  }

  // This function unzips the stream into workdir
  const unzip = () => {
    // Create the unzipper
    const unzipper = new DecompressZip(etsProjectFilePath)
    return new Promise((resolve, reject) => {
      // Install handlers
      unzipper.on('error', err => {
        reject(err)
      })
      unzipper.on('extract', () => {
        resolve()
      })
      // Start the extraction process
      unzipper.extract({
        path: self.workdir
      })
    })
  }

  // This function finds the project information folder
  const findProjectInfoFolder = () => {
    try {
      // Look trough the list of names - everything starting with 'P-' is a project folder
      self.projectFolderPath = fs.readdirSync(workdir).map(name => {
        if (name.startsWith('P-')) {
          // Create the full path of the found node
          let fullName = workdir + '/' + name
          // Check if it is a file or a folder
          if (fs.statSync(fullName).isDirectory()) {
            // This node is valid
            return fullName
          }
        }
        /*
         * Filter out all undefined elements that resulted from items.map()
         * Only the first project folder found is used
         */
      }).filter(value => {
        return value || 0
      })[0]

      // Check if anything was found
      if (!self.projectFolderPath) {
        // Error - unable to find matching folders
        return Error(util.format('The file \'%s\' does not contain any projects!', etsProjectFilePath))
      }
    } catch (e) {
      connsole.log('e', e)
      return (e)
    }
  }

  const parseProjectInformation = () => {
    return new Promise(resolve => {
      try {
        // Create a read stream on the project.xml file
        const stream = fs.createReadStream(self.projectFolderPath + '/project.xml')
        // Initialize a XML parser
        const xmlParser = sax.createStream(true)
        // A temporary object needed to parse project information
        let tmp = { application: undefined, version: undefined, projectID: undefined }

        // This will be called on every new element
        xmlParser.on('opentag', (element) => {
          switch (element.name) {
            case ('KNX'):
              tmp.application = element.attributes['CreatedBy']
              tmp.version = element.attributes['ToolVersion']
              break
            case ('Project'):
              tmp.projectID = element.attributes['Id']
              break
            case ('ProjectInformation'):
              self.project = {
                ID: tmp.projectID,
                name: element.attributes['Name'],
                application: tmp.application,
                version: tmp.version,
                groupAddressStyle: element.attributes['GroupAddressStyle'],
                deviceCount: element.attributes['DeviceCount'],
                lastModified: element.attributes['LastModified'],
                comment: element.attributes['Comment'],
                codePage: element.attributes['CodePage'],
                lastUsedPuid: element.attributes['LastUsedPuid'],
                guid: element.attributes['Guid'],
                comopletionStatus: element.attributes['CompletionStatus'],
                projectStart: element.attributes['ProjectStart']
              }
              break
          }
        })

        // This will be called when the whole stream was parsed
        xmlParser.on('end', () => {
          resolve()
        })

        // This will be called on error
        xmlParser.on('error', err => {
          resolve(err)
        })

        // Start the stream
        stream.pipe(xmlParser)
      } catch (e) {
        resolve(e)
      }
    })
  }

  // This function extracts the project from workdir/projectFolder/0.xml
  const parseProject = () => {
    return new Promise(resolve => {
      try {
        // Create a read stream on the 0.xml file
        const stream = fs.createReadStream(self.projectFolderPath + '/0.xml')
        // Initialize a XML parser
        const xmlParser = sax.createStream(true)

        // Used to close everything up and resolve
        const closeStreamAndResolve = (resolveValue) => {
          stream.close()
          resolve(resolveValue)
        }

        // This will be called on every new element
        xmlParser.on('opentag', (element) => {
          switch (element.name) {
            case ('GroupAddress'):
              if (!self?.project?.groupAddresses) {
                self.project.groupAddresses = []
              }
              self.project.groupAddresses.push({
                id: element.attributes['Id'],
                name: element.attributes['Name'],
                address: parseInt(element.attributes['Address']),
                description: element.attributes['Description'],
                datapointType: element.attributes['DatapointType'],
                unfiltered: element.attributes['Unfiltered'],
                central: stringToBool(element.attributes['Central'])
              })
              break
          }
        })

        // This will be called on error
        xmlParser.on('error', (err) => {
          closeStreamAndResolve(err)
        })

        // This will be called when the whole stream was parsed
        xmlParser.on('end', () => {
          closeStreamAndResolve()
        })

        // Start the stream
        stream.pipe(xmlParser)
      } catch (e) {
        resolve(e)
      }
    })
  }


  await initEtsProjectParser(etsProjectFilePath, workdir)
  await findProjectInfoFolder()
  await Promise.all([parseProjectInformation(), parseProject()])

  // Clean workfolder
  cleanWorkdir(workdir)
  return self.project
}

exports.etsProjectParser = etsProjectParser

