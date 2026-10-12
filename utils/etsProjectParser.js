const fs = require('fs')
const crypto = require('crypto')
const { Readable } = require('stream')
const zip = require('@zip.js/zip.js')
const sax = require('sax')
const { stringToBool } = require('./stringToBool.js');
const { formatGroupAddress } = require('./formatGa.js');
const { formatDatapointType } = require('./formatDatapointType.js');

// no web workers in node; decryption and inflation run inline
zip.configure({ useWebWorkers: false })

// ETS6 protects the inner project zip with AES, and its zip password is
// derived from the user's project password (as xknxproject does):
// base64(PBKDF2-HMAC-SHA256(utf-16le password, "21.project.ets.knx.org", 65536, 32)).
// ETS4/5 use ZipCrypto with the plain password.
function ets6ZipPassword(password) {
  return crypto.pbkdf2Sync(Buffer.from(password, 'utf16le'), '21.project.ets.knx.org', 65536, 32, 'sha256')
    .toString('base64')
}

async function readEntry(entry, password) {
  try {
    const options = password === undefined ? {} : { password }
    return Buffer.from(await entry.getData(new zip.Uint8ArrayWriter(), options))
  } catch (err) {
    if (err.message === zip.ERR_INVALID_PASSWORD) throw new Error('BAD_PASSWORD')
    if (err.message === zip.ERR_ENCRYPTED) throw new Error('MISSING_PASSWORD')
    throw err
  }
}

// project.xml (Project.xml for ETS4) and 0.xml, by name within the project folder
function pickProjectFiles(entries) {
  const byName = name => entries.find(e => !e.directory && e.filename.split('/').pop().toLowerCase() === name)
  return { info: byName('project.xml'), project: byName('0.xml') }
}

// Reads project.xml and 0.xml straight from the archive: nothing is extracted
// to disk, so entry paths in an uploaded archive are never used as file paths.
async function readProjectFiles(etsProjectFilePath, password) {
  const reader = new zip.ZipReader(new zip.BlobReader(await fs.openAsBlob(etsProjectFilePath)))
  try {
    const entries = await reader.getEntries()

    // everything at the top level starting with 'P-' is a project folder, or
    // an encrypted project zip; only the first one found is used
    const projectName = entries
      .map(e => e.filename.split('/')[0])
      .filter((name, i, all) => name.startsWith('P-') && all.indexOf(name) === i)
      .filter(name => name.endsWith('.zip') || entries.some(e => e.filename.startsWith(name + '/')))
      .sort()[0]
    if (!projectName) {
      throw new Error(`The file '${etsProjectFilePath}' does not contain any projects!`)
    }

    if (!projectName.endsWith('.zip')) {
      const { info, project } = pickProjectFiles(entries.filter(e => e.filename.startsWith(projectName + '/')))
      return { info: info && await readEntry(info), project: project && await readEntry(project) }
    }

    // encrypted project folder
    console.log('Project folder is encrypted, unpacking it with passed password..')
    const inner = await readEntry(entries.find(e => e.filename === projectName))
    const innerReader = new zip.ZipReader(new zip.Uint8ArrayReader(new Uint8Array(inner)))
    try {
      const innerEntries = await innerReader.getEntries()
      const encrypted = innerEntries.filter(e => e.encrypted)
      if (encrypted.length > 0 && !password) throw new Error('MISSING_PASSWORD')
      const aes = encrypted.some(e => !e.zipCrypto)
      const { info, project } = pickProjectFiles(innerEntries)
      const read = async pass => ({
        info: info && await readEntry(info, info.encrypted ? pass : undefined),
        project: project && await readEntry(project, project.encrypted ? pass : undefined)
      })
      if (!aes) return await read(password)
      try {
        return await read(ets6ZipPassword(password))
      } catch (err) {
        // not the ETS6 derivation: try the password as given before giving up
        if (err.message !== 'BAD_PASSWORD') throw err
        return await read(password)
      }
    } finally {
      await innerReader.close()
    }
  } finally {
    await reader.close()
  }
}

// Feeds a buffer through a sax parser; parse errors end the parse without
// failing the upload, as before
function parseXml(buffer, onOpenTag) {
  return new Promise(resolve => {
    const xmlParser = sax.createStream(true)
    xmlParser.on('opentag', onOpenTag)
    xmlParser.on('end', () => resolve())
    xmlParser.on('error', err => resolve(err))
    Readable.from([buffer]).pipe(xmlParser)
  })
}

// The workdir argument is kept for callers but no longer used
const etsProjectParser = async function (etsProjectFilePath, password, workdir) {
  const files = await readProjectFiles(etsProjectFilePath, password)
  if (!files.info) throw new Error('Project file not found')

  let project = { groupAddresses: [] }

  // project information from project.xml
  const tmp = { application: undefined, version: undefined, projectID: undefined }
  await parseXml(files.info, element => {
    switch (element.name) {
      case ('KNX'):
        tmp.application = element.attributes['CreatedBy']
        tmp.version = element.attributes['ToolVersion']
        break
      case ('Project'):
        tmp.projectID = element.attributes['Id']
        break
      case ('ProjectInformation'):
        project = {
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
          projectStart: element.attributes['ProjectStart'],
          groupAddresses: []
        }
        break
    }
  })

  // group addresses from 0.xml, after project.xml so the two can't race
  if (files.project) {
    await parseXml(files.project, element => {
      if (element.name === 'GroupAddress') {
        project.groupAddresses.push({
          id: element.attributes['Id'],
          name: element.attributes['Name'],
          address: formatGroupAddress(parseInt(element.attributes['Address'])),
          description: element.attributes['Description'],
          dpt: formatDatapointType(element.attributes['DatapointType']),
          unfiltered: element.attributes['Unfiltered'],
          central: stringToBool(element.attributes['Central'])
        })
      }
    })
  }

  return project
}

exports.etsProjectParser = etsProjectParser
