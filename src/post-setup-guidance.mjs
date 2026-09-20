/**
 * Post-setup / success handoff: install complete → start work.
 * Host only reports what it can observe. It never claims an open Agent
 * session already loaded tools, and never leaves only "not guaranteed".
 */

export const POST_SETUP_GUIDANCE_SCHEMA = 'openadam.agent-host-post-setup-guidance.v0.1'

export const PROBLEM_CLASSES = Object.freeze({
  NOT_CONNECTED: 'not-connected',
  STALE_SESSION: 'stale-session',
  PERMISSION: 'permission',
  TOOL_FAULT: 'tool-fault',
  UNVERIFIED: 'unverified',
})

export const PRIMARY_ACTIONS = Object.freeze({
  START_NEW_TASK: 'start-new-agent-task',
  CONNECT_AGENT: 'connect-agent',
  REVIEW_REPAIR: 'review-repair',
  RUN_FULL_CHECK: 'run-full-check',
  GRANT_WORKSPACE: 'grant-workspace',
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
      title: 'Permission or workspace access is blocking work',
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
      title: 'A tool or local service needs repair before work',
      summary: tool.message || 'Host observed a tool or runtime fault.',
      recoveryPath: 'Review Repair (or Run Full Check), fix the named fault, then open a new Agent task. Do not keep working in an old task.',
    }
  }
  if (errors.length > 0) {
    return {
      problemClass: PROBLEM_CLASSES.TOOL_FAULT,
      primaryActionId: PRIMARY_ACTIONS.RUN_FULL_CHECK,
      title: 'Environment checks need attention before work',
      summary: errors[0].message || 'Host observed a blocking environment check.',
      recoveryPath: 'Run Full Check, follow the recovery for the named check, then open a new Agent task.',
    }
  }
  return null
}

function actionFor(id, appName) {
  switch (id) {
    case PRIMARY_ACTIONS.CONNECT_AGENT:
      return {
        id,
        label: 'Connect an Agent app',
        detail: 'Open Agents, connect one supported app, then start a new task there.',
      }
    case PRIMARY_ACTIONS.REVIEW_REPAIR:
      return {
        id,
        label: 'Review Repair',
        detail: 'Repair restores Host-observed faults. It does not invent success for things Host cannot see.',
      }
    case PRIMARY_ACTIONS.RUN_FULL_CHECK:
      return {
        id,
        label: 'Run Full Check',
        detail: 'Confirm current bindings and tool readiness before starting work.',
      }
    case PRIMARY_ACTIONS.GRANT_WORKSPACE:
      return {
        id,
        label: 'Fix permission / grant workspace',
        detail: 'Grant the project folder the tool needs, then open a new Agent task.',
      }
    case PRIMARY_ACTIONS.START_NEW_TASK:
    default:
      return {
        id: PRIMARY_ACTIONS.START_NEW_TASK,
        label: appName ? `Open a new ${appName} task to start work` : 'Open a new Agent task to start work',
        detail: 'Already-open tasks keep the tools they started with. A new task is the path into real work.',
      }
  }
}

/**
 * @param {object} input
 * @param {boolean} [input.configured]
 * @param {string[]} [input.connectedHosts]
 * @param {number} [input.installedToolCount]
 * @param {number} [input.activeToolCount]
 * @param {boolean} [input.agentToolsPaused]
 * @param {boolean} [input.needsFreshTask]
 * @param {boolean|null} [input.agentAppsVerified] null = not checked yet
 * @param {Array<{id:string,message?:string}>} [input.doctorBlockingErrors]
 * @param {boolean} [input.justInstalled]
 * @param {string|null} [input.primaryHostName]
 * @param {boolean} [input.workspaceGranted]
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
  const workspaceGranted = input.workspaceGranted

  if (!configured) {
    return {
      schemaVersion: POST_SETUP_GUIDANCE_SCHEMA,
      phase: 'setup',
      readyToWork: false,
      problemClass: null,
      title: 'Set up tools before starting work',
      summary: 'Install a tool set first. Success is starting work afterward, not a green checklist.',
      observed: [],
      gaps: ['No Agent environment is installed yet.'],
      primaryAction: {
        id: 'run-setup',
        label: 'Set up tools',
        detail: 'Choose a tool set, optionally connect an Agent app, then install.',
      },
      recoveryPath: null,
      destinationIsWork: true,
    }
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

  const gaps = []
  // Always honest about session loading — Host cannot observe an open task's catalog.
  gaps.push('Host cannot confirm that an already-open Agent task has loaded these tools.')

  const fault = classifyDoctorFault(doctorBlockingErrors)
  if (fault) {
    gaps.push(fault.summary)
    return {
      schemaVersion: POST_SETUP_GUIDANCE_SCHEMA,
      phase: 'recover',
      readyToWork: false,
      problemClass: fault.problemClass,
      title: fault.title,
      summary: fault.summary,
      observed,
      gaps,
      primaryAction: actionFor(fault.primaryActionId, primaryHostName),
      recoveryPath: fault.recoveryPath,
      destinationIsWork: true,
    }
  }

  if (connectedHosts.length === 0) {
    gaps.push('Connect an Agent app before expecting tools in a session.')
    return {
      schemaVersion: POST_SETUP_GUIDANCE_SCHEMA,
      phase: 'connect-agent',
      readyToWork: false,
      problemClass: PROBLEM_CLASSES.NOT_CONNECTED,
      title: 'Install finished — connect an Agent to start work',
      summary: 'Tools are on this machine, but no Agent app is connected yet.',
      observed,
      gaps,
      primaryAction: actionFor(PRIMARY_ACTIONS.CONNECT_AGENT, null),
      recoveryPath: 'Open Agents → Connect a supported app → start a new task in that app. Old tasks will not pick this up.',
      destinationIsWork: true,
    }
  }

  if (agentToolsPaused || (installedToolCount > 0 && activeToolCount === 0)) {
    gaps.push('Resume or select tools for new tasks before starting work.')
    return {
      schemaVersion: POST_SETUP_GUIDANCE_SCHEMA,
      phase: 'recover',
      readyToWork: false,
      problemClass: PROBLEM_CLASSES.TOOL_FAULT,
      title: 'Tools are installed but not available for new tasks',
      summary: agentToolsPaused
        ? 'Ordinary tools are paused. Resume them, then open a new Agent task.'
        : 'No installed tool is selected for new tasks. Choose a working set, then open a new Agent task.',
      observed,
      gaps,
      primaryAction: {
        id: 'open-tools',
        label: 'Open Tools to enable a working set',
        detail: 'Working-set changes apply to new tasks only.',
      },
      recoveryPath: 'In Tools, resume or select at least one installed tool, then open a new Agent task.',
      destinationIsWork: true,
    }
  }

  if (needsFreshTask) {
    gaps.push('A fresh Agent task is required after the latest tool or binding change.')
    return {
      schemaVersion: POST_SETUP_GUIDANCE_SCHEMA,
      phase: 'fresh-task',
      readyToWork: true,
      problemClass: PROBLEM_CLASSES.STALE_SESSION,
      title: 'Ready — start work in a new Agent task',
      summary: 'Host prepared tools for new tasks. An already-open task is a stale session for this change.',
      observed,
      gaps,
      primaryAction: actionFor(PRIMARY_ACTIONS.START_NEW_TASK, primaryHostName),
      recoveryPath: 'Close or ignore the old task. Open a new task in the connected Agent app and continue real work there.',
      destinationIsWork: true,
    }
  }

  if (agentAppsVerified === null && connectedHosts.length > 0) {
    gaps.push('Bindings are configured; run Full Check when you want Host to verify them.')
    return {
      schemaVersion: POST_SETUP_GUIDANCE_SCHEMA,
      phase: 'start-work',
      readyToWork: true,
      problemClass: PROBLEM_CLASSES.UNVERIFIED,
      title: 'Ready to start work',
      summary: 'Host installed and connected what it can see. Start a new Agent task — do not wait on a status checklist.',
      observed,
      gaps,
      primaryAction: actionFor(PRIMARY_ACTIONS.START_NEW_TASK, primaryHostName),
      recoveryPath: 'If tools are missing in the new task, run Full Check. Class the problem as not connected, stale session, permission, or tool fault, then follow that recovery.',
      destinationIsWork: true,
    }
  }

  if (agentAppsVerified === false) {
    gaps.push('Connected bindings failed verification.')
    return {
      schemaVersion: POST_SETUP_GUIDANCE_SCHEMA,
      phase: 'recover',
      readyToWork: false,
      problemClass: PROBLEM_CLASSES.TOOL_FAULT,
      title: 'Connected Agent bindings need repair',
      summary: 'Host connected an Agent app, but Full Check did not verify current bindings.',
      observed,
      gaps,
      primaryAction: actionFor(PRIMARY_ACTIONS.REVIEW_REPAIR, primaryHostName),
      recoveryPath: 'Review Repair or Run Full Check, then open a new Agent task after bindings verify.',
      destinationIsWork: true,
    }
  }

  return {
    schemaVersion: POST_SETUP_GUIDANCE_SCHEMA,
    phase: 'start-work',
    readyToWork: true,
    problemClass: null,
    title: justInstalled ? 'Install complete — start work' : 'Ready to start work',
    summary: 'Host confirmed the local environment it can observe. The next step is a new Agent task with real work, not more status rows.',
    observed,
    gaps,
    primaryAction: actionFor(PRIMARY_ACTIONS.START_NEW_TASK, primaryHostName),
    recoveryPath: 'If the new task cannot see tools: decide whether it is not connected, a stale session, a permission issue, or a tool fault — then use Connect, a newer task, grant/repair, or Review Repair.',
    destinationIsWork: true,
  }
}

export function guidanceFromSetupResult(result, options = {}) {
  const hosts = Array.isArray(result?.hosts) ? result.hosts : []
  const installedToolCount = Array.isArray(result?.availableAgentComponents)
    ? result.availableAgentComponents.length
    : (Array.isArray(result?.agentComponents) ? result.agentComponents.length : options.installedToolCount ?? 0)
  const activeToolCount = Array.isArray(result?.agentComponents)
    ? result.agentComponents.length
    : installedToolCount
  return buildPostSetupGuidance({
    configured: result?.status === 'installed' || result?.status === 'ready',
    connectedHosts: hosts,
    installedToolCount,
    activeToolCount,
    needsFreshTask: result?.restartRequired === true || hosts.length > 0,
    agentAppsVerified: null,
    justInstalled: result?.status === 'installed',
    primaryHostName: options.primaryHostName ?? hosts[0] ?? null,
    doctorBlockingErrors: [],
  })
}
