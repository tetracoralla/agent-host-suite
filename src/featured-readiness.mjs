import { inspectClaude } from './hosts/claude.mjs'
import { inspectCodex } from './hosts/codex.mjs'
import { inspectZcode } from './hosts/zcode.mjs'
import { inspectProductSkills, inspectProviderSkills } from './developer-kit-skill.mjs'
import { runFile } from './process.mjs'
import { FEATURED_PROFILE_ID, hostFacingManifest, isAgentToolsPaused, loadProfile } from './profile.mjs'

export const FEATURED_READINESS_SCHEMA = 'openadam.agent-host-featured-readiness.v0.1'
export const FEATURED_READINESS_TOOL = 'armorial'

export const FEATURED_READINESS_BOUNDARY = 'This report is a Host precondition. It does not establish that a live Agent session loaded the tools, chose them, or put their results into a work product. Host status, doctor, projection receipts, and observation counts are not adoption evidence.'

const RECIPE_CHECK_PREFIX = 'recipe.'

function check(id, status, message, detail = undefined) {
  return { id, status, message, ...(detail === undefined ? {} : { detail }) }
}

function rollup(checks) {
  if (checks.some((item) => item.status === 'error')) return 'error'
  if (checks.some((item) => item.status === 'warning')) return 'warning'
  return 'ok'
}

function connectedHosts(state) {
  return Object.entries(state.hosts ?? {})
    .filter(([, host]) => host != null)
    .map(([id]) => id)
}

function receiptHealthy(hostId, entry) {
  if (entry == null) return false
  if (hostId === 'codex') {
    return entry.pluginPresent === true
      && entry.pluginEnabled === true
      && entry.installedVersion === entry.requestedVersion
      && entry.installedIdentityMatched === true
  }
  return entry.present === true && entry.identityMatched === true
}

function expectedProviderSkillCount(manifest) {
  return Object.values(manifest.components ?? {}).filter((component) => component.providerSkill !== undefined).length
}

function expectedProductSkillCount(manifest) {
  const providerSkillIds = new Set(Object.values(manifest.components ?? {}).flatMap((component) => component.providerSkill?.id ?? []))
  return Object.values(manifest.components ?? {})
    .filter((component) => component.skillOnly !== true)
    .flatMap((component) => component.productSkills ?? [])
    .filter((skill) => !providerSkillIds.has(skill.id)).length
}

async function inspectLinkedSkills(hostId, hostState, agentManifest, {
  runner,
  inspectProviderSkillRecords,
  inspectProductSkillRecords,
}) {
  if (hostId === 'codex') return { healthy: true, providerSkills: null, productSkills: null }
  const providerSkills = await inspectProviderSkillRecords(hostState?.providerSkills, runner)
  const productSkills = await inspectProductSkillRecords(hostState?.productSkills, runner)
  return {
    healthy: providerSkills.status === 'ok'
      && providerSkills.skills.length === expectedProviderSkillCount(agentManifest)
      && productSkills.status === 'ok'
      && productSkills.skills.length === expectedProductSkillCount(agentManifest),
    providerSkills,
    productSkills,
  }
}

function receiptDetail(hostId, entry, skills = undefined) {
  const base = entry == null
    ? { component: FEATURED_READINESS_TOOL, host: hostId, present: false }
    : hostId === 'codex'
      ? {
        component: FEATURED_READINESS_TOOL,
        host: hostId,
        present: entry.pluginPresent === true,
        enabled: entry.pluginEnabled === true,
        identityMatched: entry.installedIdentityMatched === true,
        cacheStatus: entry.cacheStatus ?? null,
        liveCacheObserved: entry.liveCacheObserved === true,
        installedVersion: entry.installedVersion ?? null,
        requestedVersion: entry.requestedVersion ?? null,
      }
      : {
        component: FEATURED_READINESS_TOOL,
        host: hostId,
        present: entry.present === true,
        identityMatched: entry.identityMatched === true,
      }
  if (skills == null || hostId === 'codex') return base
  return { ...base, providerSkills: skills.providerSkills, productSkills: skills.productSkills }
}

function nextStepsFor(checks) {
  const tools = checks.find((item) => item.id === 'user.tools')
  const connection = checks.find((item) => item.id === 'user.connection')
  return {
    startFreshTask: 'Open a fresh Agent task in a connected app after the current bindings. Already-open tasks keep the tools they started with.',
    missingTools: tools?.status === 'error' ? tools.message : null,
    connectAgent: connection?.status === 'error' ? connection.message : null,
    completedWork: 'Completed work is the Agent putting results into the work product on an unnamed task. doctor --featured-readiness is a Host precondition and is not adoption evidence. See docs/ADOPTION_ACCEPTANCE.md.',
  }
}

function report(checks) {
  const userChecks = checks.filter((item) => !item.id.startsWith(RECIPE_CHECK_PREFIX))
  const recipeChecks = checks.filter((item) => item.id.startsWith(RECIPE_CHECK_PREFIX))
  const userStatus = rollup(userChecks)
  const recipeStatus = recipeChecks.length === 0 ? 'ok' : rollup(recipeChecks)
  return {
    schemaVersion: FEATURED_READINESS_SCHEMA,
    status: userStatus,
    userStatus,
    recipeStatus,
    adoptionEvidence: false,
    assessmentBoundary: FEATURED_READINESS_BOUNDARY,
    nextSteps: nextStepsFor(checks),
    checks,
  }
}

async function inspectHostReceipt(hostId, state, agentManifest, {
  runner,
  inspectCodexHost,
  inspectClaudeHost,
  inspectZcodeHost,
  codexConfiguration,
}) {
  if (hostId === 'codex') {
    return inspectCodexHost(agentManifest, runner, {
      managedState: state.hosts.codex,
      useManagedBindings: true,
      codexConfiguration,
    })
  }
  if (hostId === 'claude') {
    return inspectClaudeHost(agentManifest, runner, state.hosts.claude, {
      workspaceRoot: state.workspaceRoot ?? null,
    })
  }
  if (hostId === 'zcode') {
    return inspectZcodeHost(agentManifest, runner, state.hosts.zcode, {
      workspaceRoot: state.workspaceRoot ?? null,
    })
  }
  return null
}

function activeWorkingSet(state) {
  if (isAgentToolsPaused(state)) return []
  return [...(state.agentComponents ?? [])]
}

export async function inspectFeaturedReadiness(state, {
  inspectAgentApps = true,
  runner = runFile,
  inspectCodexHost = inspectCodex,
  inspectClaudeHost = inspectClaude,
  inspectZcodeHost = inspectZcode,
  inspectProviderSkillRecords = inspectProviderSkills,
  inspectProductSkillRecords = inspectProductSkills,
  loadInstalledProfile = loadProfile,
  featuredToolId = FEATURED_READINESS_TOOL,
  codexConfiguration,
} = {}) {
  const checks = []
  if (state == null || typeof state.profile !== 'string' || state.profile.length === 0) {
    return report([check('user.tools', 'error', 'No Agent environment profile is installed')])
  }

  let profile
  try {
    profile = await loadInstalledProfile(state.profile)
  } catch (error) {
    return report([check('user.tools', 'error', 'The installed profile catalog could not be loaded', error.message)])
  }

  let featuredProfile
  try {
    featuredProfile = await loadInstalledProfile(FEATURED_PROFILE_ID)
  } catch (error) {
    return report([check('user.tools', 'error', 'The featured profile catalog could not be loaded', error.message)])
  }

  const active = activeWorkingSet(state)
  const installed = Object.keys(state.components ?? {})
  const featuredDefaults = [...(featuredProfile.defaultAgentComponents ?? [])]
  const recipeMissing = featuredDefaults.filter((id) => !active.includes(id))
  const extraActive = active.filter((id) => !featuredDefaults.includes(id))
  const featuredToolInstalled = installed.includes(featuredToolId)
  const featuredToolActive = active.includes(featuredToolId)
  const paused = isAgentToolsPaused(state)

  const recipeDetail = {
    profile: profile.id,
    expectedProfile: FEATURED_PROFILE_ID,
    expected: featuredDefaults,
    active,
    missing: recipeMissing,
    extra: extraActive,
    featuredTool: featuredToolId,
    featuredToolActive,
    experimentalVariable: true,
    userLevelUsesProfileName: false,
  }
  checks.push(check(
    'recipe.consistency',
    'ok',
    `Working set recorded as an experimental variable: ${active.join(', ') || 'empty'}. Extra installed tools are not a user-health failure and are not an adoption-scoring gate.`,
    recipeDetail,
  ))

  if (!featuredToolInstalled) {
    checks.push(check(
      'user.tools',
      'error',
      `${featuredToolId} is not installed. Get featured tools with update --profile featured, or import a bound catalog.`,
      { featuredTool: featuredToolId, installed: false, active: false, paused },
    ))
  } else if (paused) {
    checks.push(check(
      'user.tools',
      'error',
      'Agent tools are paused. Resume the working set, then start a fresh Agent task.',
      { featuredTool: featuredToolId, installed: true, active: false, paused: true },
    ))
  } else if (!featuredToolActive) {
    checks.push(check(
      'user.tools',
      'error',
      `${featuredToolId} is installed but not selected for new tasks. Use tools set --tool ${featuredToolId}, then start a fresh Agent task.`,
      { featuredTool: featuredToolId, installed: true, active: false, paused: false },
    ))
  } else {
    checks.push(check(
      'user.tools',
      'ok',
      `${featuredToolId} is installed and selected for new tasks`,
      { featuredTool: featuredToolId, installed: true, active: true, paused: false },
    ))
  }

  const workspaceGranted = typeof state.workspaceRoot === 'string' && state.workspaceRoot.length > 0
  checks.push(check(
    'user.permissions',
    'ok',
    workspaceGranted
      ? 'A workspace path is granted'
      : 'No workspace path is granted. Tools that need a project folder will not see one until you grant it.',
    { workspaceGranted, requiredForFeaturedTool: false },
  ))

  const hosts = connectedHosts(state)
  if (hosts.length === 0) {
    checks.push(check(
      'user.connection',
      'error',
      'No Agent app is connected. Connect one in Agent apps, then start a fresh Agent task.',
      { hosts: [] },
    ))
  } else {
    checks.push(check(
      'user.connection',
      'ok',
      `Connected Agent apps: ${hosts.join(', ')}`,
      { hosts },
    ))
  }

  checks.push(check(
    'user.task',
    'ok',
    'Host can project tools for a project-aware icon task. Projection health is not natural model choice, and this report is not adoption evidence.',
    { featuredTool: featuredToolId, adoptionEvidence: false },
  ))

  if (!inspectAgentApps) {
    checks.push(check(
      'projection.receipt',
      'warning',
      'Projection receipts were not inspected. Binding health is unverified.',
      { skipped: true, hosts },
    ))
    return report(checks)
  }
  if (hosts.length === 0) return report(checks)

  let agentManifest
  try {
    agentManifest = hostFacingManifest(
      { components: state.components ?? {} },
      active,
      { paused },
    )
  } catch (error) {
    checks.push(check(
      'projection.receipt',
      'error',
      'The Host working set cannot be projected into a Host-facing manifest',
      error.message,
    ))
    return report(checks)
  }

  const inspectOptions = {
    runner,
    inspectCodexHost,
    inspectClaudeHost,
    inspectZcodeHost,
    inspectProviderSkillRecords,
    inspectProductSkillRecords,
    codexConfiguration,
  }
  for (const hostId of hosts) {
    try {
      const inspection = await inspectHostReceipt(hostId, state, agentManifest, inspectOptions)
      if (inspection == null) {
        checks.push(check(
          `projection.receipt.${hostId}`,
          'error',
          `Unsupported connected Agent app ${hostId}`,
          { host: hostId },
        ))
        continue
      }
      const entry = inspection.entries?.find((item) => item.component === featuredToolId)
      const mcpHealthy = receiptHealthy(hostId, entry)
      const skills = await inspectLinkedSkills(hostId, state.hosts[hostId], agentManifest, inspectOptions)
      const healthy = mcpHealthy && skills.healthy
      checks.push(check(
        `projection.receipt.${hostId}`,
        healthy ? 'ok' : 'error',
        healthy
          ? `${hostId} projection receipt for ${featuredToolId} is healthy`
          : mcpHealthy && !skills.healthy
            ? `${hostId} Skill projection for ${featuredToolId} is not healthy`
            : `${hostId} projection receipt for ${featuredToolId} is not healthy`,
        receiptDetail(hostId, entry, skills),
      ))
    } catch (error) {
      checks.push(check(
        `projection.receipt.${hostId}`,
        'error',
        `${hostId} projection receipt inspection failed`,
        error.message,
      ))
    }
  }
  return report(checks)
}
