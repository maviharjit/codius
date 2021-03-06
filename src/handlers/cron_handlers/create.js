const { getCurrencyDetails, unitsPerHost } = require('../../common/price.js')
const { checkPricesOnHosts } = require('../../common/host-utils.js')
const { getCodiusState, saveCodiusState } = require('../../common/codius-state.js')
const { uploadManifestToHosts } = require('../../common/manifest-upload.js')
const ora = require('ora')
const statusIndicator = ora({ text: '', color: 'blue', spinner: 'point' })
const crontab = require('crontab')
const logger = require('riverpig')('codius-cli:createCronHandler')
const jsome = require('jsome')
const { promisify } = require('util')
const { getHostsStatus } = require('../../common/host-utils')
const fse = require('fs-extra')
const inquirer = require('inquirer')
const { getExtendTimes, generateExtendCmd } = require('../../common/cron-utils.js')
const { checkExpirationDates } = require('../../common/utils.js')
const defaultExtendTime = 3600
const { spawnSync } = require('child_process')

function getBufferExtendOptions ({ bufferSec, maxMonthlyRate, units }, codiusStateOptions, codiusStateFilePath) {
  return {
    maxMonthlyRate: maxMonthlyRate || codiusStateOptions.maxMonthlyRate,
    units: units || codiusStateOptions.units,
    duration: bufferSec,
    codiusStateFile: codiusStateFilePath
  }
}

function getCronExtendOptions ({ maxMonthlyRate, units }, codiusStateOptions, codiusStateFilePath) {
  return {
    maxMonthlyRate: maxMonthlyRate || codiusStateOptions.maxMonthlyRate,
    units: units || codiusStateOptions.units,
    duration: defaultExtendTime,
    codiusStateFile: codiusStateFilePath
  }
}

async function checkExistingJobs (manifestHash) {
  const load = promisify(crontab.load)
  const cron = await load()
  const jobs = await cron.jobs({comment: manifestHash})
  if (jobs.length > 0) {
    logger.debug(`Existing jobs: ${jobs}`)
    throw new Error(`A cron job already exists for ${manifestHash}, please remove it before proceeding.`)
  }
}

async function addCronJob (cmd, manifestHash) {
  const cronJob = {}
  const load = promisify(crontab.load)
  const cron = await load()
  const notice = `This line has been auto-generated by the codius cli for pod ${manifestHash}; do not modify it by hand`
  const job = cron.create(cmd, '@hourly', notice)

  if (job == null) {
    throw new Error(`Failed to create new cron job instance with command '${cmd}' and notice '${notice}'`)
  }

  cronJob.job = job.toString()
  cronJob.creationDate = ((new Date()).toUTCString())
  cron.save()
  logger.debug(`Successfully created and saved cron job ${JSON.stringify(cronJob)}`)
  return cronJob
}

async function extendByBuffer (options, { codiusStateFilePath, codiusStateJson }) {
  statusIndicator.start('Checking buffer extend options')
  if (options.bufferSec < defaultExtendTime) {
    throw new Error('Buffer time must be greater than the cron extend time (1 hr)')
  }
  statusIndicator.succeed()

  statusIndicator.start('Getting Codius State Details')
  const manifestJson = codiusStateJson.generatedManifest
  const statusDetails = getHostsStatus(codiusStateJson)
  const hostList = codiusStateJson.hostList
  statusIndicator.succeed()

  statusIndicator.start(`Calculating extend times required to maintain a buffer of ${options.bufferSec} sec`)
  const extendTimes = getExtendTimes(statusDetails, options.bufferSec)
  const extendOptions = getBufferExtendOptions(options, codiusStateJson.options, codiusStateFilePath)
  statusIndicator.succeed()

  if (!options.assumeYes) {
    console.info('Extending Manifest:')
    jsome(manifestJson)
    console.info('on the following host(s) with these duration(s):')
    jsome(extendTimes)
    console.info('with the current status:')
    jsome(statusDetails)
    console.info('with options:')
    jsome(extendOptions)

    const userResp = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'continueToExtend',
        message: `Do you want to proceed with extending the pod?`,
        default: false
      }
    ])
    if (!userResp.continueToExtend) {
      statusIndicator.start('User declined to extend pod')
      throw new Error('Extend aborted by user')
    }
  }

  statusIndicator.start('Calculating Max Monthly Rate')
  const maxMonthlyRate = await unitsPerHost(extendOptions)
  const currencyDetails = await getCurrencyDetails()
  statusIndicator.succeed()

  statusIndicator.start(`Checking Host(s) Monthly Rate vs Max Monthly Rate ${maxMonthlyRate.toString()} ${currencyDetails}`)
  await checkPricesOnHosts(hostList, extendOptions.duration, maxMonthlyRate, manifestJson)
  statusIndicator.succeed()

  statusIndicator.start(`Extending pod on ${hostList.length} host(s)`)
  const hosts = Object.keys(extendTimes)
  const uploadHostResponses = { success: [], failed: [] }
  const skippedHosts = []
  hosts.map(async (host) => {
    const duration = extendTimes[host]
    if (duration > 0) {
      const uploadHostList = [host]
      const responses = await uploadManifestToHosts(statusIndicator,
        uploadHostList, duration, maxMonthlyRate, manifestJson)
      uploadHostResponses.success = [...uploadHostResponses.success, ...responses.success]
      uploadHostResponses.failed = [...uploadHostResponses.failed, ...responses.failed]
    } else {
      skippedHosts.push(host)
    }
  })

  if (skippedHosts.length > 0) {
    statusIndicator.info('Skipped extend for the following host(s), buffer already maintained:')
    jsome(skippedHosts)
  }
  statusIndicator.succeed()
  if (uploadHostResponses.success.length > 0) {
    statusIndicator.start('Updating Codius State File')
    const saveStateOptions = {
      codiusStateFile: codiusStateFilePath,
      maxMonthlyRate: extendOptions.maxMonthlyRate,
      units: extendOptions.units,
      duration: options.bufferSec
    }
    await saveCodiusState(saveStateOptions, manifestJson, uploadHostResponses, codiusStateJson)
    statusIndicator.succeed(`Codius State File: ${codiusStateFilePath} updated`)
  }
}

async function extendWithCron (options, { codiusStateFilePath, codiusStateJson }) {
  const statusDetails = getHostsStatus(codiusStateJson)
  statusIndicator.start(`Checking expiration dates for running pods`)
  checkExpirationDates(statusDetails)
  statusIndicator.succeed()

  const extendOptions = getCronExtendOptions(options, codiusStateJson.options, codiusStateFilePath)
  statusIndicator.start('Generating extend command for cron job')
  const extendCmd = await generateExtendCmd(extendOptions)
  logger.debug(`Successfully generated cron job extend command: '${extendCmd}'`)
  statusIndicator.succeed()
  const hostList = codiusStateJson.hostList

  if (!options.assumeYes) {
    console.info(`Creating cron job to extend manifest every ${extendOptions.duration} seconds with the following command: ${extendCmd}`)
    console.info('on the following host(s):')
    jsome(hostList)
    console.info('with the current status:')
    jsome(statusDetails)

    const userResp = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'continueToCronExtend',
        message: `Do you want to continue creating the cron job for extending the pod?`,
        default: false
      }
    ])
    if (!userResp.continueToCronExtend) {
      statusIndicator.start('User declined to create cron job')
      throw new Error('Cron Extend aborted by user')
    }
  }

  const cronJob = await addCronJob(extendCmd, codiusStateJson.manifestHash)
  console.info('Successfully created new extend cron job:')
  jsome(cronJob)
  console.info('Saving cron job to Codius State File')
  const savedCronJobs = codiusStateJson.status.cronJobs
  if (savedCronJobs && savedCronJobs.length) {
    savedCronJobs.push(cronJob)
  } else {
    codiusStateJson.status.cronJobs = [cronJob]
  }
  await fse.writeJson(codiusStateFilePath, codiusStateJson)
  statusIndicator.succeed(`Codius State File: ${codiusStateFilePath} updated`)
}

async function checkCodiusInstallation () {
  statusIndicator.start('Testing global installation of codius cli')
  const child = spawnSync('codius', ['--version'])
  const err = child.stderr ? child.stderr.toString().trim() : ''
  const codiusVersion = child.stdout ? child.stdout.toString().trim() : ''
  if (err || !codiusVersion) {
    throw new Error(`Unable to run codius cli commands. Check global installation. Test command: codius --version. ${err}`)
  }
  statusIndicator.succeed()
}

async function createCron (options) {
  try {
    await checkCodiusInstallation()
    const codiusState = await getCodiusState(statusIndicator, options)
    const manifestHash = codiusState.codiusStateJson.manifestHash
    await checkExistingJobs(manifestHash)
    if (!options.skipExtend) {
      await extendByBuffer(options, codiusState)
    }
    await extendWithCron(options, codiusState)
    process.exit(0)
  } catch (err) {
    statusIndicator.fail()
    logger.error(err.message)
    logger.debug(err)
    process.exit(1)
  }
}

module.exports = {
  createCron
}
