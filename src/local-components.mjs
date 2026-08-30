import { lstat, mkdtemp, realpath, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { fingerprintIdentityFiles, fingerprintRelativeFiles } from './development-manifest.mjs'
import { recordActivity } from './activity.mjs'
import { containedComponentPath, currentReleasePlatform, installDirectoryName } from './release-manifest.mjs'
import { materializeLocalComponentArtifact, observeLocalComponentArtifact, verifyReleaseComponent } from './release-artifacts.mjs'
import { probeMcpToolsFirstAndRepeat } from './mcp-health.mjs'
import { resolveStateRoot } from './paths.mjs'
import { loadState, prepareStatePaths } from './state.mjs'
import { transitionComponentInventory } from './lifecycle.mjs'
import { TOOL_INTEGRATION_SCHEMA_V2 } from './tool-integration.mjs'
import { resolveWorkspaceRoot } from './hosts/codex-projection.mjs'
import { readJson } from './json.mjs'
import { isSpdxExpressionSyntax } from './spdx-expression.mjs'

const PRIVATE_COMPONENT_STATE_SCHEMA = 'openadam.agent-host-private-component-state.v0.1'
const PREVIEW_SCHEMA = 'openadam.agent-host-local-component-preview.v0.1'
const REMOVED_ROLLBACK_TARGET = Object.freeze({ removed: true })
const ACTIVITY_LOG_WARNING = Object.freeze({
  code: 'ACTIVITY_LOG_WRITE_FAILED',
  message: 'The private component change succeeded, but its activity entry could not be recorded.',
})

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

async function recordCommittedActivity(dependencies, paths, type, summary, detail) {
  try {
    await (dependencies.recordActivity ?? recordActivity)(paths, type, summary, detail)
    return []
  } catch {
    // State and host bindings are authoritative once the inventory transition
    // returns. Do not report that committed change as failed merely because
    // the append-only activity projection is unavailable.
    return [ACTIVITY_LOG_WARNING]
  }
}

async function cleanupUnadoptedPackage(prepared) {
  if (prepared?.installed.created !== true) return
  const packageRoot = dirname(prepared.installed.root)
  await rm(prepared.installed.root, { recursive: true, force: true })
  try {
    await rmdir(packageRoot)
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
  }
}

function directoryPath(root, value, label) {
  if (typeof value !== 'string' || value.includes('\\')) fail('COMPONENT_DESCRIPTOR_INVALID', `${label} is invalid`)
  const target = resolve(root, value)
  const relation = relative(root, target)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    fail('COMPONENT_DESCRIPTOR_INVALID', `${label} escapes the installed component`)
  }
  return target
}

function bindingFromObservation(observation, spdx) {
  if (!isSpdxExpressionSyntax(spdx)) {
    fail('LOCAL_COMPONENT_SPDX_REQUIRED', 'Component preview requires one syntactically valid SPDX license expression')
  }
  return {
    archiveSha256: observation.observed.archiveSha256,
    archiveBytes: observation.observed.archiveBytes,
    descriptorSha256: observation.observed.descriptorSha256,
    id: observation.descriptor.id,
    version: observation.descriptor.version,
    platform: currentReleasePlatform(),
    spdx,
  }
}

function assertAgentTool(installed) {
  if (installed.descriptor.kind !== 'agent-tool') {
    fail('LOCAL_COMPONENT_KIND_UNSUPPORTED', 'Local import accepts only a sealed agent-tool component')
  }
  const integration = installed.descriptor.integration
  const command = installed.descriptor.files.find((file) => file.path === integration.runtime.command)
  if (integration.runtime.executor !== 'suite-node' && command?.executable !== true) {
    fail('LOCAL_COMPONENT_COMMAND_NOT_EXECUTABLE', 'A component-executed tool must mark its contained runtime command executable')
  }
}

async function runtimeComponent(installed, releaseComponent, state) {
  assertAgentTool(installed)
  const integration = installed.descriptor.integration
  const identities = [
    installed.descriptorPath,
    ...installed.descriptor.identityFiles.map((path) => containedComponentPath(installed.root, path, `${installed.descriptor.id} identity file`)),
  ]
  const pluginRoot = directoryPath(installed.root, integration.codex.pluginRoot, `${integration.displayName} plugin root`)
  const marketplaceRoot = directoryPath(installed.root, integration.codex.marketplaceRoot, `${integration.displayName} marketplace root`)
  const runtimeEntrypoint = containedComponentPath(installed.root, integration.runtime.command, `${integration.displayName} runtime command`)
  const usesSuiteNode = integration.schemaVersion === TOOL_INTEGRATION_SCHEMA_V2 && integration.runtime.executor === 'suite-node'
  const nodeCommand = state.components['node-runtime']?.command
  if (usesSuiteNode && typeof nodeCommand !== 'string') {
    fail('LOCAL_COMPONENT_EXECUTOR_UNAVAILABLE', 'The installed Agent environment has no verified Suite Node executor')
  }
  return {
    version: installed.descriptor.version,
    root: installed.root,
    identityFiles: identities,
    fingerprint: await fingerprintIdentityFiles(identities),
    descriptorPath: installed.descriptorPath,
    releaseArtifact: releaseComponent,
    displayName: integration.displayName,
    summary: integration.summary,
    pluginRoot,
    marketplaceRoot,
    marketplace: integration.codex.marketplace,
    plugin: integration.codex.plugin,
    pluginIdentityRelativeFiles: integration.codex.identityFiles,
    pluginIdentityFingerprint: await fingerprintRelativeFiles(pluginRoot, integration.codex.identityFiles),
    command: usesSuiteNode ? nodeCommand : runtimeEntrypoint,
    args: usesSuiteNode ? [runtimeEntrypoint, ...integration.runtime.args] : integration.runtime.args,
    cwd: directoryPath(installed.root, integration.runtime.cwd, `${integration.displayName} runtime directory`),
    workspaceEnvironment: integration.runtime.workspaceEnvironment ?? [],
    expectedTools: integration.runtime.expectedTools,
    healthTimeoutMs: integration.runtime.timeoutMs,
    toolIntegrationSchema: integration.schemaVersion,
  }
}

function inventoryFromState(state) {
  return {
    components: { ...state.components },
    availableAgentComponents: [...(state.availableAgentComponents ?? state.agentComponents ?? Object.keys(state.components))],
    agentComponents: [...(state.agentComponents ?? state.availableAgentComponents ?? Object.keys(state.components))],
    privateComponents: structuredClone(state.privateComponents ?? {}),
  }
}

function publicRecord(id, record, active) {
  const current = record.current
  const rollback = record.rollback
  return {
    id,
    installed: current !== null,
    active: current !== null && active.includes(id),
    version: current?.binding.version ?? null,
    archiveSha256: current?.binding.archiveSha256 ?? null,
    importedAt: current?.importedAt ?? null,
    rollback: rollback === null || rollback === undefined ? null : {
      installed: rollback.removed !== true,
      version: rollback.removed === true ? null : rollback.binding.version,
      archiveSha256: rollback.removed === true ? null : rollback.binding.archiveSha256,
      active: rollback.removed === true ? false : rollback.active,
    },
  }
}

async function installedState(stateRoot) {
  const paths = await prepareStatePaths(resolveStateRoot(stateRoot))
  const state = await loadState(paths)
  if (state === null) fail('NOT_INSTALLED', 'No Agent environment is installed')
  return { paths, state }
}

async function materializeForPreview(options, state, dependencies) {
  const initial = await observeLocalComponentArtifact(options.artifact, { runner: dependencies.artifactRunner })
  const binding = bindingFromObservation(initial, options.licenseSpdx)
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-host-component-admission-'))
  try {
    const prepared = await materializeLocalComponentArtifact(options.artifact, binding, { packages: temporaryRoot }, { runner: dependencies.artifactRunner })
    const component = await runtimeComponent(prepared.installed, prepared.releaseComponent, state)
    const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot ?? state.workspaceRoot)
    if (component.workspaceEnvironment.length > 0 && workspaceRoot === null) {
      fail('WORKSPACE_GRANT_REQUIRED', `${component.displayName} requires --workspace-root before its private component can be admitted`)
    }
    const health = await (dependencies.mcpProbe ?? probeMcpToolsFirstAndRepeat)({ ...component, healthWorkspaceRoot: workspaceRoot })
    return { initial, binding, component, health }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export async function previewLocalComponent(options, dependencies = {}) {
  const { state } = await installedState(options.stateRoot)
  const { initial, binding, health } = await materializeForPreview(options, state, dependencies)
  return {
    schemaVersion: PREVIEW_SCHEMA,
    status: 'ready',
    dryRun: true,
    binding,
    component: {
      id: initial.descriptor.id,
      version: initial.descriptor.version,
      kind: initial.descriptor.kind,
      displayName: initial.descriptor.integration.displayName,
      integrationSchema: initial.descriptor.integration.schemaVersion,
      executor: initial.descriptor.integration.runtime.executor ?? 'component',
      expectedTools: initial.descriptor.integration.runtime.expectedTools,
      files: initial.observed.fileCount,
      expandedBytes: initial.observed.expandedBytes,
    },
    limits: initial.limits,
    health,
    assessment: {
      establishes: ['archive-and-descriptor-integrity', 'contained-file-inventory', 'closed-tool-integration', 'current-mcp-catalog-health'],
      doesNotEstablish: ['license-rights', 'tool-value', 'semantic-correctness', 'agent-selection', 'task-quality'],
      execution: {
        componentProcessStarted: true,
        agentHostStateChanged: false,
        effectsOutsideAgentHostState: 'not-observed',
      },
    },
  }
}

function assertImportCollision(state, id, replace) {
  const record = state.privateComponents?.[id]
  if (state.components[id] !== undefined && record?.current?.component === undefined) {
    fail('LOCAL_COMPONENT_ID_RESERVED', `Component ${id} is owned by the installed compatibility release`)
  }
  if (record?.current !== null && record?.current !== undefined && replace !== true) {
    fail('LOCAL_COMPONENT_REPLACE_REQUIRED', `Component ${id} is already imported; use --replace to retain it as the rollback target`)
  }
  return record
}

export async function importLocalComponent(options, dependencies = {}) {
  const { paths, state } = await installedState(options.stateRoot)
  const runner = dependencies.runner
  const observation = await observeLocalComponentArtifact(options.artifact, { runner: dependencies.artifactRunner })
  const binding = options.binding
  const record = assertImportCollision(state, observation.descriptor.id, options.replace)
  let prepared = null
  let inventoryAdopted = false
  try {
    prepared = await materializeLocalComponentArtifact(options.artifact, binding, paths, { runner: dependencies.artifactRunner })
    const component = await runtimeComponent(prepared.installed, prepared.releaseComponent, state)
    const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot ?? state.workspaceRoot)
    if (component.workspaceEnvironment.length > 0 && workspaceRoot === null) {
      fail('WORKSPACE_GRANT_REQUIRED', `${component.displayName} requires --workspace-root before its private component can be admitted`)
    }
    const health = await (dependencies.mcpProbe ?? probeMcpToolsFirstAndRepeat)({ ...component, healthWorkspaceRoot: workspaceRoot })
    const inventory = inventoryFromState(state)
    const wasActive = inventory.agentComponents.includes(binding.id)
    const active = options.activate === true || wasActive
    const previousCurrent = record === undefined
      ? null
      : record.current === null
        ? structuredClone(REMOVED_ROLLBACK_TARGET)
        : { ...record.current, active: wasActive }
    inventory.components[binding.id] = component
    if (!inventory.availableAgentComponents.includes(binding.id)) inventory.availableAgentComponents.push(binding.id)
    if (active && !inventory.agentComponents.includes(binding.id)) inventory.agentComponents.push(binding.id)
    inventory.privateComponents[binding.id] = {
      schemaVersion: PRIVATE_COMPONENT_STATE_SCHEMA,
      current: { binding: structuredClone(binding), component, importedAt: new Date().toISOString(), active },
      rollback: previousCurrent,
    }
    const transition = await transitionComponentInventory(options, inventory, { ...dependencies, runner })
    if (options.dryRun === true) {
      await cleanupUnadoptedPackage(prepared)
      return {
        ...transition,
        schemaVersion: PREVIEW_SCHEMA,
        component: {
          id: binding.id,
          installed: false,
          active: false,
          version: binding.version,
          archiveSha256: binding.archiveSha256,
          importedAt: null,
          rollback: null,
        },
        health,
      }
    }
    // Once the state transition succeeds, the installed package is owned by the
    // persisted inventory. A later activity-log failure must not delete bytes
    // that the active state now references.
    inventoryAdopted = true
    const warnings = [
      ...(transition.warnings ?? []),
      ...await recordCommittedActivity(dependencies, paths, 'private-component.imported', `${component.displayName} imported`, {
        component: binding.id,
        version: binding.version,
        active,
      }),
    ]
    return {
      status: 'imported',
      component: publicRecord(binding.id, inventory.privateComponents[binding.id], inventory.agentComponents),
      health,
      restartRequired: transition.restartRequired,
      projectionCleanup: transition.projectionCleanup,
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  } catch (error) {
    if (!inventoryAdopted) await cleanupUnadoptedPackage(prepared).catch(() => {})
    throw error
  }
}

export async function localComponentStatus(options = {}) {
  const { state } = await installedState(options.stateRoot)
  const active = state.agentComponents ?? []
  const records = Object.entries(state.privateComponents ?? {})
    .filter(([id]) => options.target === undefined || options.target === id)
    .map(([id, record]) => publicRecord(id, record, active))
    .sort((left, right) => left.id.localeCompare(right.id))
  if (options.target !== undefined && records.length === 0) fail('LOCAL_COMPONENT_UNKNOWN', `No private component is recorded for ${options.target}`)
  return { status: 'ok', components: records }
}

export async function removeLocalComponent(options, dependencies = {}) {
  const { paths, state } = await installedState(options.stateRoot)
  const record = state.privateComponents?.[options.target]
  if (record?.current === null || record?.current === undefined) fail('LOCAL_COMPONENT_UNKNOWN', `No imported component is installed for ${options.target}`)
  const inventory = inventoryFromState(state)
  delete inventory.components[options.target]
  inventory.availableAgentComponents = inventory.availableAgentComponents.filter((id) => id !== options.target)
  inventory.agentComponents = inventory.agentComponents.filter((id) => id !== options.target)
  inventory.privateComponents[options.target] = {
    schemaVersion: PRIVATE_COMPONENT_STATE_SCHEMA,
    current: null,
    rollback: { ...record.current, active: (state.agentComponents ?? []).includes(options.target) },
  }
  const transition = await transitionComponentInventory(options, inventory, dependencies)
  let warnings = [...(transition.warnings ?? [])]
  if (options.dryRun !== true) {
    warnings.push(...await recordCommittedActivity(dependencies, paths, 'private-component.removed', `${record.current.component.displayName} removed`, {
      component: options.target,
      version: record.current.binding.version,
      packageRetainedForRollback: true,
    }))
  }
  return {
    ...transition,
    status: options.dryRun === true ? 'ready' : 'removed',
    component: publicRecord(options.target, inventory.privateComponents[options.target], inventory.agentComponents),
    ...(warnings.length === 0 ? {} : { warnings }),
  }
}

function retainedBindingMismatches(target) {
  const release = target?.component?.releaseArtifact
  const binding = target?.binding
  if (release === null || typeof release !== 'object' || binding === null || typeof binding !== 'object') return ['metadata']
  const actual = {
    archiveSha256: release.artifact?.sha256,
    archiveBytes: release.artifact?.bytes,
    descriptorSha256: release.descriptorSha256,
    id: release.id,
    version: release.version,
    platform: release.platform,
    spdx: release.license?.spdx,
  }
  return Object.entries(actual).filter(([key, value]) => binding[key] !== value).map(([key]) => key)
}

async function verifyRetainedRollbackTarget(paths, state, target, options, dependencies) {
  const mismatches = retainedBindingMismatches(target)
  if (mismatches.length > 0) {
    fail('LOCAL_COMPONENT_ROLLBACK_BINDING_MISMATCH', 'The retained component metadata differs from its approved import binding', { fields: mismatches })
  }
  const release = target.component.releaseArtifact
  const expectedRoot = join(paths.packages, target.binding.id, installDirectoryName(release))
  let component
  let workspaceRoot
  try {
    const info = await lstat(expectedRoot)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('retained package root is not a real directory')
    const [packageRoot, actualRoot, retainedRoot] = await Promise.all([
      realpath(paths.packages),
      realpath(target.component.root),
      realpath(expectedRoot),
    ])
    if (actualRoot !== retainedRoot || (retainedRoot !== packageRoot && !retainedRoot.startsWith(`${packageRoot}${sep}`))) {
      throw new Error('retained package root differs from its content-addressed location')
    }
    await verifyReleaseComponent({ root: retainedRoot, releaseArtifact: release })
    const descriptorPath = join(retainedRoot, 'component.json')
    const descriptor = await readJson(descriptorPath)
    component = await runtimeComponent({ root: retainedRoot, descriptor, descriptorPath }, release, state)
    workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot ?? state.workspaceRoot)
    if (component.workspaceEnvironment.length > 0 && workspaceRoot === null) {
      fail('WORKSPACE_GRANT_REQUIRED', `${component.displayName} requires --workspace-root before its private component can be restored`)
    }
  } catch (error) {
    if (error instanceof AgentHostError && ['WORKSPACE_GRANT_REQUIRED'].includes(error.code)) throw error
    fail('LOCAL_COMPONENT_ROLLBACK_BYTES_UNVERIFIED', `Retained bytes failed exact verification for ${target.binding.id}`, {
      cause: error instanceof AgentHostError ? error.code : 'PACKAGE_ROOT_INVALID',
    })
  }
  const health = await (dependencies.mcpProbe ?? probeMcpToolsFirstAndRepeat)({ ...component, healthWorkspaceRoot: workspaceRoot })
  return { component, health }
}

export async function rollbackLocalComponent(options, dependencies = {}) {
  const { paths, state } = await installedState(options.stateRoot)
  const record = state.privateComponents?.[options.target]
  if (record?.rollback === null || record?.rollback === undefined) fail('LOCAL_COMPONENT_ROLLBACK_UNAVAILABLE', `No private component rollback is retained for ${options.target}`)
  const target = record.rollback
  if (target.removed === true) {
    const inventory = inventoryFromState(state)
    delete inventory.components[options.target]
    inventory.availableAgentComponents = inventory.availableAgentComponents.filter((id) => id !== options.target)
    inventory.agentComponents = inventory.agentComponents.filter((id) => id !== options.target)
    inventory.privateComponents[options.target] = {
      schemaVersion: PRIVATE_COMPONENT_STATE_SCHEMA,
      current: null,
      rollback: { ...record.current, active: (state.agentComponents ?? []).includes(options.target) },
    }
    const transition = await transitionComponentInventory(options, inventory, dependencies)
    let warnings = [...(transition.warnings ?? [])]
    if (options.dryRun !== true) {
      warnings.push(...await recordCommittedActivity(dependencies, paths, 'private-component.rolled-back', `${record.current.component.displayName} removal restored`, {
        component: options.target,
        version: record.current.binding.version,
        active: false,
      }))
    }
    return {
      ...transition,
      status: options.dryRun === true ? 'ready' : 'rolled-back',
      component: publicRecord(options.target, inventory.privateComponents[options.target], inventory.agentComponents),
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }
  const verified = await verifyRetainedRollbackTarget(paths, state, target, options, dependencies)
  const verifiedTarget = { ...target, component: verified.component }
  const inventory = inventoryFromState(state)
  inventory.components[options.target] = verifiedTarget.component
  if (!inventory.availableAgentComponents.includes(options.target)) inventory.availableAgentComponents.push(options.target)
  inventory.agentComponents = inventory.agentComponents.filter((id) => id !== options.target)
  if (verifiedTarget.active) inventory.agentComponents.push(options.target)
  inventory.privateComponents[options.target] = {
    schemaVersion: PRIVATE_COMPONENT_STATE_SCHEMA,
    current: verifiedTarget,
    rollback: record.current === null ? structuredClone(REMOVED_ROLLBACK_TARGET) : record.current,
  }
  const transition = await transitionComponentInventory(options, inventory, dependencies)
  let warnings = [...(transition.warnings ?? [])]
  if (options.dryRun !== true) {
    warnings.push(...await recordCommittedActivity(dependencies, paths, 'private-component.rolled-back', `${verifiedTarget.component.displayName} restored`, {
      component: options.target,
      version: verifiedTarget.binding.version,
      active: verifiedTarget.active,
    }))
  }
  return {
    ...transition,
    status: options.dryRun === true ? 'ready' : 'rolled-back',
    component: publicRecord(options.target, inventory.privateComponents[options.target], inventory.agentComponents),
    health: verified.health,
    ...(warnings.length === 0 ? {} : { warnings }),
  }
}
