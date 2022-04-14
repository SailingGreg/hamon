var fs = require('fs')
var unzipper = require('unzipper')
var sax = require('sax')
var { stringToBool } = require('./stringToBool.js');
const { formatGroupAddress } = require('./formatGa.js');
const { formatDatapointType } = require('./formatDatapointType.js');

function cleanWorkdir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const etsProjectParser = async function (etsProjectFilePath, password, workdir = '.workfolder') {
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
  const unzip = async () => {
    // Create the unzipper
    await fs.createReadStream(etsProjectFilePath).pipe(unzipper.Extract({ path: workdir })).promise();
  }

  // This function finds the project information folder
  const findProjectInfoFolder = async () => {
    // Look trough the list of names - everything starting with 'P-' is a project folder
    const resultProjectPath = fs.readdirSync(workdir).map(name => {
      if (name.startsWith('P-')) {
        // Create the full path of the found node
        let fullName = workdir + '/' + name
        // Check if it is a file, folder or encrypted zip
        if (fs.statSync(fullName).isDirectory() || fullName.endsWith('.zip')) {
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

    self.projectFolderPath = resultProjectPath

    // Handle encrypted project folder
    if (resultProjectPath.endsWith('.zip')) {
      console.log('Project folder is encrypted, unpacking it with passed password..')
      const directory = await unzipper.Open.file(resultProjectPath);
      const projectFiles = await directory.files;
      const outputDir = resultProjectPath.slice(0, -4)
      fs.mkdirSync(outputDir)
      await Promise.all(projectFiles.map(async projectFile => {
        fs.writeFileSync(outputDir + '/' + projectFile.path, await projectFile.buffer(password));
      }))
      self.projectFolderPath = outputDir
    }

    // Check if anything was found
    if (!self.projectFolderPath) {
      // Error - unable to find matching folders
      return Error(util.format('The file \'%s\' does not contain any projects!', etsProjectFilePath))
    }
  }

  const parseProjectInformation = () => {
    return new Promise(resolve => {
      try {

        // Create a read stream on the project.xml file OR Project.xml for ETS4
        let stream
        if (fs.existsSync(self.projectFolderPath + '/project.xml')) {
          stream = fs.createReadStream(self.projectFolderPath + '/project.xml')
        } else if (fs.existsSync(self.projectFolderPath + '/Project.xml')) {
          stream = fs.createReadStream(self.projectFolderPath + '/Project.xml')
        } else {
          throw new Error('Project file not found')
        }
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
                address: formatGroupAddress(parseInt(element.attributes['Address'])),
                description: element.attributes['Description'],
                dpt: formatDatapointType(element.attributes['DatapointType']),
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

  let skipRestSteps = false
  await initEtsProjectParser(etsProjectFilePath, workdir)
  await findProjectInfoFolder()
    .catch(err => {
      if (err.message == 'BAD_PASSWORD') {
        console.error('Passed password is incorrect')
        skipRestSteps = true
      } else {
        throw err
      }
    })
  if (!skipRestSteps) {
    await Promise.all([parseProjectInformation(), parseProject()])
  } else {
    console.log('Skipping rest of steps because of error')
    cleanWorkdir(workdir)
    process.exit(1)
  }

  // Clean workfolder
  cleanWorkdir(workdir)
  return self.project
}

exports.etsProjectParser = etsProjectParser

