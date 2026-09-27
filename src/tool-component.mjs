import { isAbsolute, relative, resolve, sep } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { fingerprintIdentityFiles, fingerprintRelativeFiles } from './development-manifest.mjs'
import { containedComponentPath } from './release-manifest.mjs'
import { validateToolIntegration } from './tool-integration.mjs'
import { validateProcedureIntegration } from './procedure-integration.mjs'

function fail(code, message) { throw new AgentHostError(code, message) }

function directoryPath(root, value, label) {
  if (typeof value !== 'string' || value.includes('\\')) fail('COMPONENT_DESCRIPTOR_INVALID', `${label} is invalid`)
  const target = resolve(root, value)
  const relation = relative(root, target)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    fail('COMPONENT_DESCRIPTOR_INVALID', `${label} escapes the installed component`)
  }
  return target
}

// Release profiles and private archives share the same validated integration
// lowering. The version codecs own which fields may coexist.
export async function materializeToolComponent(installed, releaseComponent, nodeCommand) {
  validateToolIntegration(installed.descriptor.integration)
  const integration = installed.descriptor.integration
  const identities = [
    installed.descriptorPath,
    ...installed.descriptor.identityFiles.map((path) => containedComponentPath(installed.root, path, `${installed.descriptor.id} identity file`)),
  ]
  const pluginRoot = directoryPath(installed.root, integration.codex.pluginRoot, `${integration.displayName} plugin root`)
  const marketplaceRoot = directoryPath(installed.root, integration.codex.marketplaceRoot, `${integration.displayName} marketplace root`)
  const runtimeEntrypoint = containedComponentPath(installed.root, integration.runtime.command, `${integration.displayName} runtime command`)
  const usesSuiteNode = integration.runtime.executor === 'suite-node'
  if (usesSuiteNode && typeof nodeCommand !== 'string') {
    fail('LOCAL_COMPONENT_EXECUTOR_UNAVAILABLE', 'The installed Agent environment has no verified Suite Node executor')
  }
  let providerSkill = null
  if (integration.discovery !== undefined) {
    const discovery = integration.discovery
    const skillRoot = directoryPath(installed.root, discovery.skill.root, `${integration.displayName} discovery Skill root`)
    const discoveryEntrypoint = containedComponentPath(installed.root, discovery.runtime.command, `${integration.displayName} discovery CLI entrypoint`)
    providerSkill = {
      id: discovery.skill.id,
      root: skillRoot,
      identityRelativeFiles: discovery.skill.identityFiles,
      identityFingerprint: await fingerprintRelativeFiles(skillRoot, discovery.skill.identityFiles),
      launcherRelativePath: discovery.skill.launcher,
      command: discovery.runtime.executor === 'suite-node' ? nodeCommand : discoveryEntrypoint,
      args: discovery.runtime.executor === 'suite-node'
        ? [discoveryEntrypoint, ...discovery.runtime.args]
        : discovery.runtime.args,
      versionArguments: discovery.runtime.versionArguments,
      expectedVersion: installed.descriptor.version,
    }
  }
  let capabilityProvider = null
  if (integration.directCapability !== undefined) {
    const capability = integration.directCapability
    capabilityProvider = {
      providerId: capability.providerId,
      transport: capability.transport,
      lifecycle: capability.lifecycle,
      workspaceRootRequired: capability.workspaceRoot === 'host-required',
      rootPath: pluginRoot,
      profilePath: containedComponentPath(installed.root, capability.profile, `${integration.displayName} Capability Profile`),
      manifestPath: containedComponentPath(installed.root, capability.manifest, `${integration.displayName} Provider Manifest`),
      identityFiles: capability.identityFiles.map((path) => containedComponentPath(installed.root, path, `${integration.displayName} Capability identity file`)),
      capabilityId: capability.capabilityId,
      capabilityVersion: capability.capabilityVersion,
      contracts: capability.contracts.map((contract) => ({
        operationId: contract.operationId,
        inputSchemaPath: containedComponentPath(installed.root, contract.inputSchema, `${integration.displayName} Capability input schema`),
        outputSchemaPath: containedComponentPath(installed.root, contract.outputSchema, `${integration.displayName} Capability output schema`),
      })),
    }
  }
  return {
    productType: 'provider',
    version: installed.descriptor.version,
    root: installed.root,
    identityFiles: identities,
    fingerprint: await fingerprintIdentityFiles(identities),
    descriptorPath: installed.descriptorPath,
    releaseArtifact: releaseComponent,
    displayName: installed.descriptor.presentation?.displayName ?? integration.displayName,
    summary: installed.descriptor.presentation?.summary ?? integration.summary,
    author: installed.descriptor.presentation?.author,
    homepage: installed.descriptor.presentation?.homepage,
    license: installed.descriptor.presentation?.license,
    logo: installed.descriptor.presentation?.logo,
    origin: installed.descriptor.origin,
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
    optionalPathEnvironment: integration.runtime.optionalPathEnvironment ?? [],
    expectedTools: integration.runtime.expectedTools,
    healthTimeoutMs: integration.runtime.timeoutMs,
    toolIntegrationSchema: integration.schemaVersion,
    ...(providerSkill === null ? {} : { providerSkill }),
    ...(capabilityProvider === null ? {} : { capabilityProvider }),
  }
}

export async function materializeProcedureComponent(installed, releaseComponent) {
  validateProcedureIntegration(installed.descriptor.integration)
  const integration = installed.descriptor.integration
  const procedure = integration.procedure
  const execution = integration.execution
  if (installed.descriptor.version !== procedure.version) {
    fail('COMPONENT_DESCRIPTOR_INVALID', 'Procedure package and product versions must match')
  }
  const identities = [
    installed.descriptorPath,
    ...installed.descriptor.identityFiles.map((path) => containedComponentPath(installed.root, path, `${installed.descriptor.id} identity file`)),
  ]
  const product = {
    id: procedure.id,
    version: procedure.version,
    permissions: [...procedure.permissions],
    permissionCeiling: [...procedure.permissions],
    resources: structuredClone(procedure.resources),
    lifecycle: structuredClone(procedure.lifecycle),
    inputSchemaPath: containedComponentPath(installed.root, procedure.inputSchema, `${integration.displayName} input schema`),
    outputSchemaPath: containedComponentPath(installed.root, procedure.outputSchema, `${integration.displayName} output schema`),
  }
  const executionBinding = execution.kind === 'direct-runtime'
    ? {
        kind: execution.kind,
        providerId: execution.providerId,
        transport: execution.transport,
        providerLifecycle: execution.providerLifecycle,
        profilePath: containedComponentPath(installed.root, execution.profile, `${integration.displayName} Procedure Profile`),
        implementationManifestPath: containedComponentPath(installed.root, execution.implementationManifest, `${integration.displayName} implementation manifest`),
        identityFiles: execution.identityFiles.map((path) => containedComponentPath(installed.root, path, `${integration.displayName} Procedure identity file`)),
      }
    : {
        kind: execution.kind,
        methodPath: containedComponentPath(installed.root, execution.method, `${integration.displayName} method`),
        outputArtifacts: [...execution.outputArtifacts],
        identityFiles: execution.identityFiles.map((path) => containedComponentPath(installed.root, path, `${integration.displayName} Procedure identity file`)),
      }
  return {
    productType: 'procedure',
    version: installed.descriptor.version,
    root: installed.root,
    identityFiles: identities,
    fingerprint: await fingerprintIdentityFiles(identities),
    descriptorPath: installed.descriptorPath,
    releaseArtifact: releaseComponent,
    displayName: installed.descriptor.presentation?.displayName ?? integration.displayName,
    summary: installed.descriptor.presentation?.summary ?? integration.summary,
    author: installed.descriptor.presentation?.author,
    homepage: installed.descriptor.presentation?.homepage,
    license: installed.descriptor.presentation?.license,
    logo: installed.descriptor.presentation?.logo,
    origin: installed.descriptor.origin,
    procedureId: procedure.id,
    procedureVersion: procedure.version,
    procedure: product,
    procedureExecution: executionBinding,
    procedureInvocation: {
      carrier: 'agent-host-cli',
      protocol: 'openadam.agent-host-procedure-invocation.v0.2',
      command: 'agent-host',
      arguments: ['procedure', 'invoke', '--request', '-', '--json'],
      describeArguments: ['procedure', 'describe', '--id', procedure.id, '--version', procedure.version, '--json'],
      statusArguments: ['procedure', 'status', '--run', '{taskId}', '--json'],
      continueArguments: ['procedure', 'continue', '--run', '{taskId}', '--input', '-', '--json'],
      input: 'json-stdin',
      output: 'json-stdout',
    },
    ...(execution.kind !== 'direct-runtime' ? {} : {
      procedureProvider: {
        providerId: execution.providerId,
        transport: execution.transport,
        lifecycle: execution.providerLifecycle,
        rootPath: installed.root,
        profilePath: executionBinding.profilePath,
        implementationManifestPath: executionBinding.implementationManifestPath,
        identityFiles: executionBinding.identityFiles,
        procedureId: procedure.id,
        procedureVersion: procedure.version,
        inputSchemaPath: product.inputSchemaPath,
        outputSchemaPath: product.outputSchemaPath,
      },
    }),
  }
}
