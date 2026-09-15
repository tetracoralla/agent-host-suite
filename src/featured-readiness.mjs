import { inspectClaude } from './hosts/claude.mjs'
import { inspectCodex } from './hosts/codex.mjs'
import { inspectZcode } from './hosts/zcode.mjs'
import { inspectProductSkills, inspectProviderSkills } from './developer-kit-skill.mjs'
import { runFile } from './process.mjs'
import { FEATURED_PROFILE_ID, hostFacingManifest, isAgentToolsPaused, loadProfile } from './profile.mjs'

export const FEATURED_READINESS_SCHEMA = 'openadam.agent-host-featured-readiness.v0.1'
export const FEATURED_READINESS_TOOL = 'armorial'

export const FEATURED_READINESS_BOUNDARY = 'This report is a Host precondition. It does not establish that a live Agent session loaded the tools, chose them, or put their results into a work product. Host status, doctor, projection receipts, and observation counts are not adoption evidence.'

function check(id, status, message, detail = undefined) {
  return { id, status, message, ...(detail === undefined ? {} : { detail }) }
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

function report(checks) {
  const errors = checks.filter((item) => item.status === 'error').length
  const warnings = checks.filter((item) => item.status === 'warning').length
  return {
    schemaVersion: FEATURED_READINESS_SCHEMA,
    status: errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'ok',
    adoptionEvidence: false,
    assessmentBoundary: FEATURED_READINESS_BOUNDARY,
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
    return report([check('featured.working-set', 'error', 'No Agent environment profile is installed')])
  }

  let profile
  try {
    profile = await loadInstalledProfile(state.profile)
  } catch (error) {
    return report([check('featured.working-set', 'error', 'The installed profile catalog could not be loaded', error.message)])
  }

  const active = [...(state.agentComponents ?? [])]
  const expected = [...(profile.defaultAgentComponents ?? [])]
  const missing = expected.filter((id) => !active.includes(id))
  const workingSetDetail = {
    profile: profile.id,
    expectedProfile: FEATURED_PROFILE_ID,
    expected,
    active,
    missing,
    featuredTool: featuredToolId,
    featuredToolActive: active.includes(featuredToolId),
  }

  if (profile.id !== FEATURED_PROFILE_ID) {
    checks.push(check(
      'featured.working-set',
      'error',
      `Featured working set is not selected (profile is ${profile.id})`,
      workingSetDetail,
    ))
  } else if (missing.length > 0 || !active.includes(featuredToolId)) {
    const absent = missing.length > 0 ? missing.join(', ') : featuredToolId
    checks.push(check(
      'featured.working-set',
      'error',
      `Featured working set is missing ${absent}`,
      workingSetDetail,
    ))
  } else {
    checks.push(check(
      'featured.working-set',
      'ok',
      'Featured working set is selected',
      workingSetDetail,
    ))
  }

  const hosts = connectedHosts(state)
  if (!inspectAgentApps) {
    checks.push(check(
      'projection.receipt',
      'warning',
      'Projection receipts were not inspected. Binding health is unverified.',
      { skipped: true, hosts },
    ))
    return report(checks)
  }
  if (hosts.length === 0) {
    checks.push(check(
      'projection.receipt',
      'error',
      'No Agent app is connected, so projection receipts cannot be inspected',
      { hosts: [] },
    ))
    return report(checks)
  }

  let agentManifest
  try {
    agentManifest = hostFacingManifest(
      { components: state.components ?? {} },
      active,
      { paused: isAgentToolsPaused(state) },
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
