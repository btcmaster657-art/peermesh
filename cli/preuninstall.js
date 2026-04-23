#!/usr/bin/env node

const { existsSync, rmSync } = require('fs')
const { join } = require('path')
const { homedir } = require('os')

console.log('')
console.log('  Uninstalling PeerMesh Provider...')
console.log('')

const configFile = join(homedir(), '.peermesh', 'config.json')
if (existsSync(configFile)) {
  console.log('  Note: Your credentials are saved in ~/.peermesh/')
  console.log('  To remove them: rm -rf ~/.peermesh')
  console.log('')
}

console.log('  Thank you for using PeerMesh!')
console.log('')
