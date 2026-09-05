import { readProcessInventory } from '../src/process-inventory.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runFile, toolSearchPath } from '../src/process.mjs'
import { currentReleasePlatform } from '../src/release-manifest.mjs'

test('release platform mapping covers supported Windows architectures', () => {
  assert.equal(currentReleasePlatform('win32', 'x64'), 'win32-x64')
  assert.equal(currentReleasePlatform('win32', 'arm64'), 'win32-arm64')
  assert.equal(currentReleasePlatform('darwin', 'x64'), 'darwin-x86_64')
  assert.throws(() => currentReleasePlatform('win32', 'ia32'), { code: 'RELEASE_PLATFORM_UNSUPPORTED' })
})

test('Windows Agent app discovery uses Windows PATH syntax and user tool locations', () => {
  const value = toolSearchPath('C:\\Windows\\System32;C:\\Tools', 'C:\\Users\\Fixture', 'win32')
  assert.equal(value.includes('C:\\Windows\\System32;C:\\Tools'), true)
  assert.equal(value.includes('C:\\Users\\Fixture\\AppData\\Roaming\\npm'), true)
  assert.equal(value.includes('C:\\Users\\Fixture\\.local\\bin'), true)
  assert.equal(value.includes(':'), true)
  assert.equal(value.split(';').length, 5)
})

test('Windows application install and restore verify state compatibility before swapping payloads', async () => {
  const installer = await readFile(new URL('../windows/Install-AgentHost.ps1', import.meta.url), 'utf8')
  const compatibilityFunction = installer.indexOf('function Assert-StateCompatibility')
  const restoreCheck = installer.indexOf('Assert-StateCompatibility $PreviousRoot')
  const restoreSwap = installer.indexOf('Move-Item -LiteralPath $InstallRoot -Destination $swapRoot')
  const installCheck = installer.indexOf('Assert-StateCompatibility $StagingRoot')
  const installSwap = installer.indexOf('Move-Item -LiteralPath $InstallRoot -Destination $PreviousRoot')
  assert.equal(compatibilityFunction >= 0, true)
  assert.equal(restoreCheck > compatibilityFunction && restoreCheck < restoreSwap, true)
  assert.equal(installCheck > restoreSwap && installCheck < installSwap, true)
})


test('Windows process inventory observes the current real process under the calling shell environment', {
  skip: process.platform !== 'win32',
}, async () => {
  const inventory = await readProcessInventory(runFile)
  assert.ok(Array.isArray(inventory), 'Windows process inventory is unavailable')
  assert.ok(inventory.some((item) => item.pid === process.pid && item.command.includes('node')))
})
