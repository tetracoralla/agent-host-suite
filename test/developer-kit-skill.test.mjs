import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fingerprintRelativeFiles } from '../src/development-manifest.mjs'
import {
  inspectDeveloperKitSkill,
  inspectProductSkills,
  inspectProviderSkills,
  installDeveloperKitSkill,
  installProductSkills,
  installProviderSkills,
  preflightDeveloperKitSkill,
  preflightProviderSkills,
  uninstallDeveloperKitSkill,
  uninstallProductSkills,
  uninstallProviderSkills,
} from '../src/developer-kit-skill.mjs'

async function fixture(root) {
  const skillRoot = join(root, 'component', 'skills', 'build-openadam-agent-tools')
  await mkdir(join(skillRoot, 'agents'), { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: build-openadam-agent-tools\n---\n')
  await writeFile(join(skillRoot, 'agents', 'openai.yaml'), 'interface:\n  display_name: Developer Kit\n')
  const cli = join(root, 'component', 'runtime', 'openadam-dev.mjs')
  await mkdir(join(cli, '..'), { recursive: true })
  await writeFile(cli, "process.stdout.write(JSON.stringify({version:'0.1.0'})+'\\n')\n")
  const identityRelativeFiles = ['SKILL.md', 'agents/openai.yaml']
  return {
    components: {
      'agent-tool-development-kit': {
        version: '0.1.0', fingerprint: 'sha256:developer-component',
        developerKitIntegrationSchema: 'openadam.agent-host-developer-kit-integration.v0.1',
        command: process.execPath, args: [cli], versionArguments: ['--version', '--json'],
        developerSkill: {
          id: 'build-openadam-agent-tools', root: skillRoot, identityRelativeFiles,
          identityFingerprint: await fingerprintRelativeFiles(skillRoot, identityRelativeFiles),
          launcherRelativePath: 'scripts/openadam-dev',
        },
      },
    },
  }
}

test('Claude Developer Skill projection installs, probes the exact CLI version, and uninstalls its own link', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-developer-skill-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await fixture(root)
  const paths = { hostProjections: join(root, 'projections'), backups: join(root, 'backups') }
  const homeRoot = join(root, 'home')
  const preview = await preflightDeveloperKitSkill('claude', manifest, paths, { homeRoot })
  assert.equal(preview.present, false)
  const managed = await installDeveloperKitSkill('claude', manifest, paths, null, { homeRoot })
  assert.equal((await lstat(managed.exposurePath)).isSymbolicLink(), true)
  assert.match(await readFile(managed.launcherPath, 'utf8'), /^#!\/bin\/sh\nexec /u)
  assert.equal((await inspectDeveloperKitSkill(managed)).status, 'ok')
  const removed = await uninstallDeveloperKitSkill(managed)
  assert.equal(removed.removed, true)
  await assert.rejects(stat(managed.exposurePath), (error) => error.code === 'ENOENT')
})

test('Claude Developer Skill follows an explicit Claude configuration root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-developer-skill-config-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await fixture(root)
  const paths = { hostProjections: join(root, 'projections'), backups: join(root, 'backups') }
  const configRoot = join(root, 'custom-claude-config')
  const managed = await installDeveloperKitSkill('claude', manifest, paths, null, { configRoot })
  assert.equal(managed.exposurePath, join(configRoot, 'skills', 'build-openadam-agent-tools'))
  assert.equal((await lstat(managed.exposurePath)).isSymbolicLink(), true)
  await uninstallDeveloperKitSkill(managed)
})

test('Claude Developer Skill replacement restores a displaced user-owned Skill', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-developer-skill-conflict-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await fixture(root)
  const paths = { hostProjections: join(root, 'projections'), backups: join(root, 'backups') }
  await mkdir(paths.backups, { recursive: true })
  const homeRoot = join(root, 'home')
  const exposurePath = join(homeRoot, '.claude', 'skills', 'build-openadam-agent-tools')
  await mkdir(exposurePath, { recursive: true })
  await writeFile(join(exposurePath, 'owner.txt'), 'keep me\n')
  await assert.rejects(
    preflightDeveloperKitSkill('claude', manifest, paths, { homeRoot }),
    (error) => error.code === 'DEVELOPER_SKILL_CONFLICT',
  )
  const managed = await installDeveloperKitSkill('claude', manifest, paths, null, { homeRoot, replaceConflicts: true })
  assert.equal((await lstat(managed.exposurePath)).isSymbolicLink(), true)
  const removed = await uninstallDeveloperKitSkill(managed)
  assert.equal(removed.restored, true)
  assert.equal(await readFile(join(exposurePath, 'owner.txt'), 'utf8'), 'keep me\n')
})

test('Claude Provider Skill projection keeps an inactive Provider directly executable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-provider-skill-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const skillRoot = join(root, 'component', 'skills', 'icon-svg-select')
  await mkdir(skillRoot, { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: icon-svg-select\n---\n')
  const cli = join(root, 'component', 'runtime', 'armorial.mjs')
  await mkdir(join(cli, '..'), { recursive: true })
  await writeFile(cli, "process.stdout.write('0.6.0\\n')\n")
  const manifest = {
    components: {
      armorial: {
        version: '0.6.0', fingerprint: 'sha256:armorial-component',
        toolIntegrationSchema: 'openadam.agent-host-tool-integration.v0.3',
        providerSkill: {
          id: 'icon-svg-select', root: skillRoot,
          identityRelativeFiles: ['SKILL.md'],
          identityFingerprint: await fingerprintRelativeFiles(skillRoot, ['SKILL.md']),
          launcherRelativePath: 'scripts/armorial',
          command: process.execPath, args: [cli], versionArguments: ['--version'], expectedVersion: '0.6.0',
        },
      },
    },
  }
  const paths = { hostProjections: join(root, 'projections'), backups: join(root, 'backups') }
  const homeRoot = join(root, 'home')
  const preview = await preflightProviderSkills('claude', manifest, paths, { homeRoot })
  assert.equal(preview.length, 1)
  const managed = await installProviderSkills('claude', manifest, paths, [], { homeRoot })
  assert.equal(managed.length, 1)
  assert.equal((await lstat(managed[0].exposurePath)).isSymbolicLink(), true)
  assert.equal((await inspectProviderSkills(managed)).status, 'ok')
  const removed = await uninstallProviderSkills(managed)
  assert.equal(removed[0].removed, true)
  await assert.rejects(stat(managed[0].exposurePath), (error) => error.code === 'ENOENT')
})

test('ZCode receives the version-locked Developer Kit Skill without an MCP binding', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-developer-skill-zcode-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await fixture(root)
  const paths = { hostProjections: join(root, 'projections'), backups: join(root, 'backups') }
  const homeRoot = join(root, 'home')
  const managed = await installDeveloperKitSkill('zcode', manifest, paths, null, { homeRoot })
  assert.equal(managed.kind, 'zcode-skill-link')
  assert.equal(managed.exposurePath, join(homeRoot, '.zcode', 'skills', 'build-openadam-agent-tools'))
  assert.equal((await lstat(managed.exposurePath)).isSymbolicLink(), true)
  assert.equal((await inspectDeveloperKitSkill(managed)).status, 'ok')
  assert.equal((await uninstallDeveloperKitSkill(managed)).removed, true)
})

test('ZCode projects an active product Skill from immutable package bytes without adding a launcher', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-product-skill-zcode-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const skillRoot = join(root, 'component', 'skills', 'calculate')
  await mkdir(join(skillRoot, 'references'), { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: calculate\n---\n')
  await writeFile(join(skillRoot, 'references', 'policy.md'), 'Use exact arithmetic.\n')
  const identityRelativeFiles = ['SKILL.md', 'references/policy.md']
  const manifest = {
    components: {
      'math-anchor': {
        version: '0.5.0', fingerprint: 'sha256:math-component',
        productSkills: [{
          id: 'calculate', root: skillRoot, identityRelativeFiles,
          identityFingerprint: await fingerprintRelativeFiles(skillRoot, identityRelativeFiles),
        }],
      },
    },
  }
  const paths = { hostProjections: join(root, 'projections'), backups: join(root, 'backups') }
  const homeRoot = join(root, 'home')
  const managed = await installProductSkills('zcode', manifest, paths, [], { homeRoot })
  assert.equal(managed.length, 1)
  assert.equal(managed[0].launcherPath, null)
  assert.equal(managed[0].expectedVersion, null)
  assert.equal((await lstat(managed[0].exposurePath)).isSymbolicLink(), true)
  assert.equal(await readFile(join(managed[0].projectionRoot, 'references', 'policy.md'), 'utf8'), 'Use exact arithmetic.\n')
  assert.equal((await inspectProductSkills(managed)).status, 'ok')
  assert.equal((await uninstallProductSkills(managed))[0].removed, true)
})
