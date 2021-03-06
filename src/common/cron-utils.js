const { spawnSync } = require('child_process')
const { dirname } = require('path')

function getExtendTimes (statusDetails, buffer) {
  const extendTimes = {}
  statusDetails.map((status) => {
    const expirationDate = status.expirationDate
    const extendTime = getExtendTime(expirationDate, buffer)
    extendTimes[status.host] = extendTime
  })
  return extendTimes
}

function getExtendTime (expirationDate, buffer) {
  // The extend time is the the no. of seconds the pod should be extended to match
  // the specified buffer time. The calculation is as follows:
  // extendTime (sec) = buffer (seconds) - (expiration (ms) - now (ms)) / 1000

  const expiration = (new Date(expirationDate))
  const now = (new Date())
  if (expiration <= now) {
    throw new Error(`Codius pod expired at ${expirationDate}, cannot extend`)
  }
  // TODO: Handle cases in which buffer is very close to remaining duration
  return Math.ceil(buffer - (expiration - now) / 1000)
}

function generateExtendCmd ({ duration, maxMonthlyRate, units, codiusStateFile }) {
  const child = spawnSync('which', ['codius'])
  const err = child.stderr ? child.stderr.toString().trim() : ''
  const codiusPath = child.stdout ? child.stdout.toString().trim() : ''
  if (err || !codiusPath) {
    throw new Error(`Unable to determine path to the global installation of codius ${err}`)
  }

  const codiusDir = dirname(codiusPath)
  return `PATH=${codiusDir} codius extend -d ${duration} --max-monthly-rate ${maxMonthlyRate} --units ${units} -y --codius-state-file ${codiusStateFile}`
}

module.exports = {
  getExtendTimes,
  generateExtendCmd
}
