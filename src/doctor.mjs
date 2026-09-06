import { readFile } from 'node:fs/promises'
import { inspectCodex } from './hosts/codex.mjs'
import { inspectClaude } from './hosts/claude.mjs'
import { inspectZcode } from './hosts/zcode.mjs'
import { runFile } from './process.mjs'
import { inspectService } from './service.mjs'
import { inspectDirectProviders } from './provider-diagnostics.mjs'
import { verifyReleaseComponent } from './release-artifacts.mjs'
import { probeMcpTools } from './mcp-health.mjs'
import { hostFacingManifest } from './profile.mjs'
import { inspectOperationsSkill } from './host-operations-skill.mjs'
import { inspectDeveloperKitSkill, inspectProductSkills, inspectProviderSkills } from './developer-kit-skill.mjs'
import { inspectMaintenance } from './maintenance-service.mjs'

function check(id, status, message, detail = undefined) {
  return { id, status, message, ...(detail === undefined ? {} : { detail }) }
}

function expectedProductSkillCount(manifest) {
  const providerSkillIds = new Set(Object.values(manifest.components).flatMap((component) => component.providerSkill?.id ?? []))
  return Object.values(manifest.components)
    .filter((component) => component.skillOnly !== true)
    .flatMap((component) => component.productSkills ?? [])
    .filter((skill) => !providerSkillIds.has(skill.id)).length
}

export async function doctor(state, {
  deep = false,
  inspectAgentApps = true,
  runner = runFile,
  mcpProbe = probeMcpTools,
  contextAnalysis = null,
  stateRoot = null,
  maintenanceInspect = inspectMaintenance,
  codexConfiguration,
} = {}) {
  const checks = []
  const agentManifest = hostFacingManifest({ components: state.components }, state.agentComponents ?? Object.keys(state.components))
  for (const [id, component] of Object.entries(state.components)) {
    try {
      if (state.channel === 'release') await verifyReleaseComponent(component)
      else for (const path of component.identityFiles) await readFile(path)
      checks.push(check(`component.${id}`, 'ok', `${id} ${component.version} installed bytes match`))
    } catch (error) {
      checks.push(check(`component.${id}`, 'error', `${id} installed files are unavailable`, error.message))
    }
  }
  const developerKit = state.components['agent-tool-development-kit']
  if (developerKit !== undefined) {
    const result = await runner(developerKit.command, [...developerKit.args, ...developerKit.versionArguments], { allowFailure: true, timeoutMs: 5_000 })
    let reportedVersion = null
    try { reportedVersion = JSON.parse(result.stdout).version } catch {}
    const ready = result.status === 0 && reportedVersion === developerKit.version
    checks.push(check(
      'developer-kit.cli',
      ready ? 'ok' : 'error',
      ready ? `Developer Kit CLI ${reportedVersion} is ready` : 'Developer Kit CLI version probe failed',
      { expectedVersion: developerKit.version, reportedVersion },
    ))
  }
  if (inspectAgentApps && state.hosts.codex !== undefined) {
    try {
      const current = await inspectCodex(agentManifest, runner, { managedState: state.hosts.codex, useManagedBindings: true, codexConfiguration })
      const missing = current.entries.filter((entry) => !entry.pluginPresent || !entry.pluginEnabled || entry.installedVersion !== entry.requestedVersion || !entry.installedIdentityMatched)
      const operationsSkill = await inspectOperationsSkill(state.hosts.codex.operationsSkill, runner, { codexConfiguration })
      const ready = missing.length === 0 && operationsSkill.status === 'ok'
      checks.push(check('host.codex', ready ? 'ok' : 'error', ready ? 'Codex plugins and Agent Host operations Skill are installed' : 'One or more Codex integrations need attention', {
        plugins: missing,
        operationsSkill,
      }))
      for (const entry of current.entries) {
        const healthy = entry.pluginPresent && entry.pluginEnabled && entry.installedVersion === entry.requestedVersion && entry.installedIdentityMatched
        checks.push(check(
          `host.codex.${entry.component}`,
          healthy ? 'ok' : 'error',
          healthy ? `${entry.component} is ready in Codex` : `${entry.component} needs attention in Codex`,
          healthy ? undefined : {
            installed: entry.pluginPresent,
            enabled: entry.pluginEnabled,
            installedVersion: entry.installedVersion,
            requestedVersion: entry.requestedVersion,
            identityMatched: entry.installedIdentityMatched,
            identityError: entry.installedIdentityError,
          },
        ))
      }
      checks.push(check('host.codex.agent-host-operations', operationsSkill.status === 'ok' ? 'ok' : 'error', operationsSkill.status === 'ok' ? 'Agent Host operations Skill is ready in Codex' : 'Agent Host operations Skill needs attention in Codex', operationsSkill))
    } catch (error) {
      checks.push(check('host.codex', 'error', 'Codex host inspection failed', error.message))
    }
  }
  if (inspectAgentApps && state.hosts.claude !== undefined) {
    try {
      const current = await inspectClaude(agentManifest, runner, state.hosts.claude, {
        workspaceRoot: state.workspaceRoot ?? null,
      })
      const missing = current.entries.filter((entry) => !entry.present || !entry.identityMatched)
      const operationsSkill = await inspectOperationsSkill(state.hosts.claude.operationsSkill, runner)
      const developerSkill = await inspectDeveloperKitSkill(state.hosts.claude.developerSkill, runner)
      const developerSkillReady = developerKit === undefined ? developerSkill.status === 'absent' : developerSkill.status === 'ok'
      const providerSkills = await inspectProviderSkills(state.hosts.claude.providerSkills, runner)
      const expectedProviderSkills = Object.values(agentManifest.components).filter((component) => component.providerSkill !== undefined).length
      const providerSkillsReady = providerSkills.status === 'ok' && providerSkills.skills.length === expectedProviderSkills
      const productSkills = await inspectProductSkills(state.hosts.claude.productSkills, runner)
      const productSkillsReady = productSkills.status === 'ok' && productSkills.skills.length === expectedProductSkillCount(agentManifest)
      const ready = missing.length === 0 && operationsSkill.status === 'ok' && developerSkillReady && providerSkillsReady && productSkillsReady
      checks.push(check('host.claude', ready ? 'ok' : 'error', ready ? 'Claude Code MCP entries and Agent Host operations Skill are present' : 'Claude Code integrations need attention', {
        entries: missing,
        operationsSkill,
        developerSkill,
        providerSkills,
        productSkills,
      }))
      for (const entry of current.entries) {
        const healthy = entry.present && entry.identityMatched
        checks.push(check(`host.claude.${entry.component}`, healthy ? 'ok' : 'error', healthy ? `${entry.component} is ready in Claude Code` : `${entry.component} needs attention in Claude Code`))
      }
      checks.push(check('host.claude.agent-host-operations', operationsSkill.status === 'ok' ? 'ok' : 'error', operationsSkill.status === 'ok' ? 'Agent Host operations Skill is ready in Claude Code' : 'Agent Host operations Skill needs attention in Claude Code', operationsSkill))
      if (developerKit !== undefined) checks.push(check('host.claude.agent-tool-development-kit', developerSkill.status === 'ok' ? 'ok' : 'error', developerSkill.status === 'ok' ? 'Developer Kit Skill and version-locked CLI are ready in Claude Code' : 'Developer Kit Skill needs attention in Claude Code', developerSkill))
      for (const skill of providerSkills.skills) {
        checks.push(check(
          `host.claude.provider-skill.${skill.id}`,
          skill.status === 'ok' ? 'ok' : 'error',
          skill.status === 'ok' ? `${skill.id} Skill and version-locked CLI are ready in Claude Code` : `${skill.id} Provider Skill needs attention in Claude Code`,
          skill,
        ))
      }
      for (const skill of productSkills.skills) {
        checks.push(check(
          `host.claude.product-skill.${skill.id}`,
          skill.status === 'ok' ? 'ok' : 'error',
          skill.status === 'ok' ? `${skill.id} product Skill is ready in Claude Code` : `${skill.id} product Skill needs attention in Claude Code`,
          skill,
        ))
      }
    } catch (error) {
      checks.push(check('host.claude', 'error', 'Claude Code host inspection failed', error.message))
    }
  }
  if (inspectAgentApps && state.hosts.zcode !== undefined) {
    try {
      const current = await inspectZcode(agentManifest, runner, state.hosts.zcode, { workspaceRoot: state.workspaceRoot ?? null })
      const missing = current.entries.filter((entry) => !entry.present || !entry.identityMatched)
      const operationsSkill = await inspectOperationsSkill(state.hosts.zcode.operationsSkill, runner)
      const developerSkill = await inspectDeveloperKitSkill(state.hosts.zcode.developerSkill, runner)
      const developerSkillReady = developerKit === undefined ? developerSkill.status === 'absent' : developerSkill.status === 'ok'
      const providerSkills = await inspectProviderSkills(state.hosts.zcode.providerSkills, runner)
      const expectedProviderSkills = Object.values(agentManifest.components).filter((component) => component.providerSkill !== undefined).length
      const providerSkillsReady = providerSkills.status === 'ok' && providerSkills.skills.length === expectedProviderSkills
      const productSkills = await inspectProductSkills(state.hosts.zcode.productSkills, runner)
      const productSkillsReady = productSkills.status === 'ok' && productSkills.skills.length === expectedProductSkillCount(agentManifest)
      const ready = missing.length === 0 && operationsSkill.status === 'ok' && developerSkillReady && providerSkillsReady && productSkillsReady
      checks.push(check('host.zcode', ready ? 'ok' : 'error', ready ? 'ZCode MCP entries and Agent Host operations Skill are present' : 'ZCode integrations need attention', {
        entries: missing,
        operationsSkill,
        developerSkill,
        providerSkills,
        productSkills,
      }))
      for (const entry of current.entries) {
        const healthy = entry.present && entry.identityMatched
        checks.push(check(`host.zcode.${entry.component}`, healthy ? 'ok' : 'error', healthy ? `${entry.component} is ready in ZCode` : `${entry.component} needs attention in ZCode`))
      }
      checks.push(check('host.zcode.agent-host-operations', operationsSkill.status === 'ok' ? 'ok' : 'error', operationsSkill.status === 'ok' ? 'Agent Host operations Skill is ready in ZCode' : 'Agent Host operations Skill needs attention in ZCode', operationsSkill))
      if (developerKit !== undefined) checks.push(check('host.zcode.agent-tool-development-kit', developerSkill.status === 'ok' ? 'ok' : 'error', developerSkill.status === 'ok' ? 'Developer Kit Skill and version-locked CLI are ready in ZCode' : 'Developer Kit Skill needs attention in ZCode', developerSkill))
      for (const skill of providerSkills.skills) {
        checks.push(check(
          `host.zcode.provider-skill.${skill.id}`,
          skill.status === 'ok' ? 'ok' : 'error',
          skill.status === 'ok' ? `${skill.id} Skill and version-locked CLI are ready in ZCode` : `${skill.id} Provider Skill needs attention in ZCode`,
          skill,
        ))
      }
      for (const skill of productSkills.skills) {
        checks.push(check(
          `host.zcode.product-skill.${skill.id}`,
          skill.status === 'ok' ? 'ok' : 'error',
          skill.status === 'ok' ? `${skill.id} product Skill is ready in ZCode` : `${skill.id} product Skill needs attention in ZCode`,
          skill,
        ))
      }
    } catch (error) {
      checks.push(check('host.zcode', 'error', 'ZCode host inspection failed', error.message))
    }
  }
  const currentPrivateComponents = Object.entries(state.privateComponents ?? {})
    .filter(([, record]) => record?.current?.component !== undefined && record.current !== null)
    .map(([id]) => id)
    .sort()
  const availableComponents = new Set(state.availableAgentComponents ?? Object.keys(state.components))
  const invalidPrivateComponents = currentPrivateComponents.filter((id) => state.components[id] === undefined || !availableComponents.has(id))
  checks.push(check(
    'private-components.inventory',
    invalidPrivateComponents.length === 0 ? 'ok' : 'error',
    invalidPrivateComponents.length === 0
      ? 'Private Agent tool records match the installed component inventory'
      : 'Private Agent tool records are missing from the installed component inventory',
    { components: currentPrivateComponents, invalid: invalidPrivateComponents },
  ))
  if (deep) {
    for (const [id, component] of Object.entries(state.components).filter(([, item]) => item.toolIntegrationSchema !== undefined)) {
      try {
        const result = await mcpProbe(component)
        checks.push(check(`tool.${id}.installed`, 'ok', `${component.displayName ?? id} installed runtime is ready`, {
          tools: result.tools,
          server: result.server,
        }))
      } catch (error) {
        checks.push(check(`tool.${id}.installed`, 'error', `${component.displayName ?? id} installed runtime needs attention`, {
          code: error.code ?? 'TOOL_HEALTH_FAILED',
        }))
      }
    }
  }
  const service = await inspectService(
    state.runtime.service === null ? null : { ...state.runtime.service, socketPath: state.runtime.socketPath },
    runner,
  )
  checks.push(check('runtime.service', service.ready ? 'ok' : 'error', service.ready ? 'Direct Runtime service is ready' : 'Direct Runtime service is not ready', service))
  if (state.observability?.enabled === true && stateRoot !== null) {
    try {
      const maintenance = await maintenanceInspect(stateRoot, state.observability.maintenance)
      checks.push(check(
        'observability.maintenance-carrier',
        maintenance.ready ? 'ok' : 'error',
        maintenance.ready
          ? 'Observer maintenance is bound to the installed Agent Host application'
          : 'Observer maintenance is not bound to the installed Agent Host application',
        maintenance,
      ))
    } catch (error) {
      checks.push(check('observability.maintenance-carrier', 'error', 'Observer maintenance application binding could not be inspected', {
        code: error.code ?? 'MAINTENANCE_INSPECTION_FAILED',
      }))
    }
  }
  if (deep) checks.push(...await inspectDirectProviders(state, service, runner))
  if (state.observability?.enabled === true && Array.isArray(contextAnalysis?.budgetChecks) && contextAnalysis.budgetChecks.length > 0) {
    const exceeded = contextAnalysis.budgetChecks.filter((item) => item?.status === 'exceeded')
    const catalogBytes = contextAnalysis.budgetChecks.find((item) => item?.metric === 'catalog.canonicalUtf8Bytes')
    const catalogRemaining = Number.isFinite(catalogBytes?.actual) && Number.isFinite(catalogBytes?.limit)
      ? catalogBytes.limit - catalogBytes.actual
      : null
    checks.push(check(
      'context.catalog',
      exceeded.length === 0 ? 'ok' : 'warning',
      exceeded.length === 0
        ? `The active tool catalog is within its declared resource limits${catalogRemaining === null ? '' : ` with ${catalogRemaining} canonical UTF-8 bytes remaining`}`
        : `The active tool catalog exceeds ${exceeded.length} declared resource limit${exceeded.length === 1 ? '' : 's'}`,
      { exceeded, catalogRemaining },
    ))
  }
  const errors = checks.filter((item) => item.status === 'error').length
  const warnings = checks.filter((item) => item.status === 'warning').length
  return { status: errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'ok', checks }
}
