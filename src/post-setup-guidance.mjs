/**
 * Post-setup / success handoff: install complete → start work.
 * Host only reports what it can observe. Main UI is one status line + one
 * primary action; observed/gaps/recovery stay for on-demand details only.
 */

export const POST_SETUP_GUIDANCE_SCHEMA = 'openadam.agent-host-post-setup-guidance.v0.1'

export const PROBLEM_CLASSES = Object.freeze({
  NOT_CONNECTED: 'not-connected',
  STALE_SESSION: 'stale-session',
  PERMISSION: 'permission',
  TOOL_FAULT: 'tool-fault',
  TOOLS_PAUSED: 'tools-paused',
  UNVERIFIED: 'unverified',
})

export const PRIMARY_ACTIONS = Object.freeze({
  OPEN_APP: 'open-app',
  /** @deprecated prefer OPEN_APP; kept for callers that still emit the old id */
  START_NEW_TASK: 'start-new-agent-task',
  CONNECT_AGENT: 'connect-agent',
  REVIEW_REPAIR: 'review-repair',
  RUN_FULL_CHECK: 'run-full-check',
  GRANT_WORKSPACE: 'grant-workspace',
  RESUME_TOOLS: 'resume-tools',
  OPEN_TOOLS: 'open-tools',
})

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))]
}

function blockingDoctor(errors) {
  return Array.isArray(errors) ? errors.filter((item) => item && typeof item.id === 'string') : []
}

function classifyDoctorFault(errors) {
  const permission = errors.find((item) => (
    item.id.includes('permission')
    || item.id.includes('workspace')
    || /permission|workspace|grant|access denied|EACCES|EPERM/iu.test(item.message ?? '')
  ))
  if (permission) {
    return {
      problemClass: PROBLEM_CLASSES.PERMISSION,
      primaryActionId: PRIMARY_ACTIONS.GRANT_WORKSPACE,
      statusLine: shortReason(permission.message, 'Permission blocked'),
      title: 'Permission blocked',
      summary: permission.message || 'Host observed a permission or workspace problem.',
      recoveryPath: 'Fix the permission or grant the project folder, run Full Check, then open a new Agent task.',
    }
  }
  const tool = errors.find((item) => (
    item.id === 'profile.catalog'
    || item.id.startsWith('component.')
    || item.id.startsWith('runtime.')
    || (item.id.startsWith('tool.') && (item.id.endsWith('.installed') || item.id.endsWith('.direct')))
    || item.id.startsWith('host.')
  ))
  if (tool) {
    return {
      problemClass: PROBLEM_CLASSES.TOOL_FAULT,
      primaryActionId: PRIMARY_ACTIONS.REVIEW_REPAIR,
      statusLine: shortReason(tool.message, 'Needs repair'),
      title: 'Needs repair',
      summary: tool.message || 'Host observed a tool or runtime fault.',
      recoveryPath: 'Review Repair (or Run Full Check), fix the named fault, then open a new Agent task.',
    }
  }
  if (errors.length > 0) {
    return {
      problemClass: PROBLEM_CLASSES.TOOL_FAULT,
      primaryActionId: PRIMARY_ACTIONS.RUN_FULL_CHECK,
      statusLine: shortReason(errors[0].message, 'Needs check'),
      title: 'Needs check',
      summary: errors[0].message || 'Host observed a blocking environment check.',
      recoveryPath: 'Run Full Check, follow the recovery for the named check, then open a new Agent task.',
    }
  }
  return null
}

function shortReason(message, fallback) {
  if (typeof message !== 'string' || message.trim() === '') return fallback
  const one = message.trim().split(/[\r\n]/u)[0]
  return one.length > 72 ? `${one.slice(0, 69)}…` : one
}

function actionFor(id, appName) {
  switch (id) {
    case PRIMARY_ACTIONS.CONNECT_AGENT:
      return { id, label: 'Connect' }
    case PRIMARY_ACTIONS.REVIEW_REPAIR:
      return { id, label: 'Repair' }
    case PRIMARY_ACTIONS.RUN_FULL_CHECK:
      return { id, label: 'Check' }
    case PRIMARY_ACTIONS.GRANT_WORKSPACE:
      return { id, label: 'Fix access' }
    case PRIMARY_ACTIONS.RESUME_TOOLS:
      return { id, label: 'Resume' }
    case PRIMARY_ACTIONS.OPEN_TOOLS:
      return { id, label: 'Tools' }
    case PRIMARY_ACTIONS.OPEN_APP:
    case PRIMARY_ACTIONS.START_NEW_TASK:
    default:
      return {
        id: PRIMARY_ACTIONS.OPEN_APP,
        label: appName ? `Open ${appName}` : 'Open Agent',
      }
  }
}

function pack(base) {
  return {
    schemaVersion: POST_SETUP_GUIDANCE_SCHEMA,
    destinationIsWork: true,
    hint: null,
    ...base,
  }
}

/**
 * @param {object} input
 */
export function buildPostSetupGuidance(input = {}) {
  const configured = input.configured === true
  const connectedHosts = unique(input.connectedHosts ?? [])
  const installedToolCount = Number.isFinite(input.installedToolCount) ? input.installedToolCount : 0
  const activeToolCount = Number.isFinite(input.activeToolCount) ? input.activeToolCount : 0
  const agentToolsPaused = input.agentToolsPaused === true
  const needsFreshTask = input.needsFreshTask === true
  const agentAppsVerified = input.agentAppsVerified === undefined ? null : input.agentAppsVerified
  const doctorBlockingErrors = blockingDoctor(input.doctorBlockingErrors)
  const justInstalled = input.justInstalled === true
  const primaryHostName = typeof input.primaryHostName === 'string' && input.primaryHostName.length > 0
    ? input.primaryHostName
    : (connectedHosts[0] ?? null)
  const primaryHostId = typeof input.primaryHostId === 'string' && input.primaryHostId.length > 0
    ? input.primaryHostId
    : null
  const workspaceGranted = input.workspaceGranted

  if (!configured) {
    return pack({
      phase: 'setup',
      readyToWork: false,
      problemClass: null,
      statusLine: 'Set up tools',
      statusTone: 'action',
      title: 'Set up tools',
      summary: 'Install a tool set first.',
      observed: [],
      gaps: ['No Agent environment is installed yet.'],
      primaryAction: { id: 'run-setup', label: 'Set up' },
      recoveryPath: null,
    })
  }

  const observed = []
  if (justInstalled) observed.push('Host finished installing the selected tool set on this machine.')
  else observed.push('An Agent environment is installed on this machine.')
  if (installedToolCount > 0) {
    observed.push(`Host can see ${installedToolCount} installed tool package${installedToolCount === 1 ? '' : 's'}.`)
  } else {
    observed.push('Host does not yet see installed Agent tool packages in this environment.')
  }
  if (agentToolsPaused) {
    observed.push('Ordinary Agent tools are fully paused for new tasks.')
  } else if (activeToolCount > 0) {
    observed.push(`Host selected ${activeToolCount} tool${activeToolCount === 1 ? '' : 's'} for new Agent tasks.`)
  } else if (installedToolCount > 0) {
    observed.push('Tools are installed, but none are selected for new Agent tasks.')
  }
  if (connectedHosts.length > 0) {
    observed.push(`Connected Agent app${connectedHosts.length === 1 ? '' : 's'}: ${connectedHosts.join(', ')}.`)
  } else {
    observed.push('No Agent app is connected yet.')
  }
  if (agentAppsVerified === true) {
    observed.push('Full Check verified current Agent-app bindings.')
  } else if (agentAppsVerified === false && connectedHosts.length > 0) {
    observed.push('Connected Agent-app bindings need attention.')
  }
  if (workspaceGranted === true) observed.push('A workspace path is granted.')
  if (workspaceGranted === false) observed.push('No workspace path is granted yet.')

  const gaps = ['Host cannot confirm that an already-open Agent task has loaded these tools.']

  const fault = classifyDoctorFault(doctorBlockingErrors)
  if (fault) {
    gaps.push(fault.summary)
    return pack({
      phase: 'recover',
      readyToWork: false,
      problemClass: fault.problemClass,
      statusLine: fault.statusLine,
      statusTone: 'fault',
      title: fault.title,
      summary: fault.summary,
      observed,
      gaps,
      primaryAction: actionFor(fault.primaryActionId, primaryHostName),
      recoveryPath: fault.recoveryPath,
      primaryHostId,
    })
  }

  if (connectedHosts.length === 0) {
    gaps.push('Connect an Agent app before expecting tools in a session.')
    return pack({
      phase: 'connect-agent',
      readyToWork: false,
      problemClass: PROBLEM_CLASSES.NOT_CONNECTED,
      statusLine: 'Connect Agent to use',
      statusTone: 'action',
      title: 'Connect Agent to use',
      summary: 'Tools are on this machine, but no Agent app is connected yet.',
      observed,
      gaps,
      primaryAction: actionFor(PRIMARY_ACTIONS.CONNECT_AGENT, null),
      recoveryPath: 'Open Agents → Connect a supported app → start a new task in that app. Old tasks will not pick this up.',
      primaryHostId,
    })
  }

  if (agentToolsPaused) {
    gaps.push('Resume tools for new tasks before starting work.')
    return pack({
      phase: 'recover',
      readyToWork: false,
      problemClass: PROBLEM_CLASSES.TOOLS_PAUSED,
      statusLine: 'Tools paused',
      statusTone: 'paused',
      title: 'Tools paused',
      summary: 'Ordinary tools are paused.',
      observed,
      gaps,
      primaryAction: actionFor(PRIMARY_ACTIONS.RESUME_TOOLS, primaryHostName),
      recoveryPath: 'Resume tools, then open a new Agent task.',
      primaryHostId,
    })
  }

  if (installedToolCount > 0 && activeToolCount === 0) {
    gaps.push('Select tools for new tasks before starting work.')
    return pack({
      phase: 'recover',
      readyToWork: false,
      problemClass: PROBLEM_CLASSES.TOOLS_PAUSED,
      statusLine: 'No tools selected',
      statusTone: 'action',
      title: 'No tools selected',
      summary: 'Choose a working set for new tasks.',
      observed,
      gaps,
      primaryAction: actionFor(PRIMARY_ACTIONS.OPEN_TOOLS, primaryHostName),
      recoveryPath: 'In Tools, select at least one installed tool, then open a new Agent task.',
      primaryHostId,
    })
  }

  if (agentAppsVerified === false) {
    gaps.push('Connected bindings failed verification.')
    return pack({
      phase: 'recover',
      readyToWork: false,
      problemClass: PROBLEM_CLASSES.TOOL_FAULT,
      statusLine: 'Bindings need repair',
      statusTone: 'fault',
      title: 'Bindings need repair',
      summary: 'Full Check did not verify current bindings.',
      observed,
      gaps,
      primaryAction: actionFor(PRIMARY_ACTIONS.REVIEW_REPAIR, primaryHostName),
      recoveryPath: 'Review Repair or Run Full Check, then open a new Agent task after bindings verify.',
      primaryHostId,
    })
  }

  const openAction = actionFor(PRIMARY_ACTIONS.OPEN_APP, primaryHostName)
  const readyLine = justInstalled ? 'Ready' : (needsFreshTask ? 'Ready' : 'Ready')
  return pack({
    phase: needsFreshTask ? 'fresh-task' : 'start-work',
    readyToWork: true,
    problemClass: needsFreshTask
      ? PROBLEM_CLASSES.STALE_SESSION
      : (agentAppsVerified === null ? PROBLEM_CLASSES.UNVERIFIED : null),
    statusLine: readyLine,
    statusTone: 'ready',
    title: readyLine,
    summary: 'Open the connected Agent app to start work.',
    observed,
    gaps,
    primaryAction: openAction,
    hint: 'Start a new task in the app',
    recoveryPath: 'If the new task cannot see tools: decide whether it is not connected, a stale session, a permission issue, or a tool fault — then use Connect, a newer task, grant/repair, or Review Repair.',
    primaryHostId,
  })
}

export function guidanceFromSetupResult(result, options = {}) {
  const hosts = Array.isArray(result?.hosts) ? result.hosts : []
  const installedToolCount = Array.isArray(result?.availableAgentComponents)
    ? result.availableAgentComponents.length
    : (Array.isArray(result?.agentComponents) ? result.agentComponents.length : options.installedToolCount ?? 0)
  const activeToolCount = Array.isArray(result?.agentComponents)
    ? result.agentComponents.length
    : installedToolCount
  const hostNames = { zcode: 'ZCode', codex: 'Codex', claude: 'Claude Code' }
  const primaryHostId = options.primaryHostId ?? hosts[0] ?? null
  const primaryHostName = options.primaryHostName
    ?? (primaryHostId ? (hostNames[primaryHostId] || primaryHostId) : null)
  return buildPostSetupGuidance({
    configured: result?.status === 'installed' || result?.status === 'ready',
    connectedHosts: hosts.map((id) => hostNames[id] || id),
    installedToolCount,
    activeToolCount,
    needsFreshTask: result?.restartRequired === true || hosts.length > 0,
    agentAppsVerified: null,
    justInstalled: result?.status === 'installed',
    primaryHostName,
    primaryHostId,
    doctorBlockingErrors: [],
  })
}
