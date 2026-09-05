import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assessCostExperimentTask } from './local-dogfood-cost-assessment.mjs'

const suiteRoot = fileURLToPath(new URL('../', import.meta.url))
const outputRoot = join(suiteRoot, '.build', 'cost-experiment')
const model = process.env.AGENT_HOST_COST_EXPERIMENT_MODEL ?? 'gpt-5.6-luna'
const repetitions = Number(process.env.AGENT_HOST_COST_EXPERIMENT_RUNS ?? '1')
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error('AGENT_HOST_COST_EXPERIMENT_RUNS must be 1, 2, or 3')
const requestedTaskIds = new Set((process.env.AGENT_HOST_COST_EXPERIMENT_TASKS ?? '').split(',').filter(Boolean))

const corpus = [
  { id: 'no-tool', prompt: '只回复“收到”，不要调用任何工具。', expected: 'no-tool' },
  { id: 'math', prompt: '求 x^3 对 x 的一阶导数。必须使用已安装的可靠数学工具，只回复最终精确结果。', expected: 'math' },
  { id: 'time', prompt: '把 2026-11-01 03:30 America/New_York 转换到 Asia/Shanghai。必须使用已安装的时区工具，只回复转换结果。', expected: 'time' },
  { id: 'file', prompt: '读取当前目录 package.json 的 name 字段，只回复字段值；优先使用最适合的已安装文件工具。', expected: 'file' },
]
const tasks = requestedTaskIds.size === 0 ? corpus : corpus.filter((task) => requestedTaskIds.has(task.id))
if (tasks.length === 0 || tasks.length !== (requestedTaskIds.size || tasks.length)) throw new Error('AGENT_HOST_COST_EXPERIMENT_TASKS contains an unknown task id')

const standardPlugins = new Set(['math-anchor@math-anchor-agent-host', 'migratory-time@migratory-time'])
const localPlugins = new Set([
  ...standardPlugins,
  'context-surface-analyzer@context-surface-analyzer',
  'data-transformer@data-transformer-local',
  'armorial@openadam-local',
  'laniakea@laniakea',
  'projective@projective-local',
  'equatorium@equatorium',
  'file-vitals@file-vitals-local',
])

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} experiment timed out`))
    }, 180_000)
    child.stdout.on('data', (value) => { stdout += value })
    child.stderr.on('data', (value) => { stderr += value })
    child.once('error', reject)
    child.once('exit', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

function toolName(item) {
  if (item.type === 'command_execution') return 'shell'
  return item.tool_name ?? item.toolName ?? item.name ?? item.server ?? item.type
}

function summarizeEvents(stdout) {
  const events = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const completed = events.filter((event) => event.type === 'item.completed').map((event) => event.item)
  const agentMessage = [...completed].reverse().find((item) => item.type === 'agent_message')?.text ?? ''
  const toolItems = completed.filter((item) => item.type !== 'agent_message' && item.type !== 'reasoning')
  const turn = [...events].reverse().find((event) => event.type === 'turn.completed')
  return {
    usage: turn?.usage ?? null,
    toolSequence: toolItems.map(toolName),
    toolCallCount: toolItems.length,
    finalSha256: createHash('sha256').update(agentMessage).digest('hex'),
    finalText: agentMessage,
  }
}

const profileRoot = process.env.CODEX_HOME ?? join(homedir(), '.codex')
const profilePaths = []

function profileDocument(enabled) {
  return [...localPlugins].sort().map((pluginId) => `[plugins.${JSON.stringify(pluginId)}]\nenabled = ${enabled.has(pluginId)}\n`).join('\n')
}

function pluginSkillMarker(pluginId) {
  return new Map([
    ['math-anchor@math-anchor-agent-host', 'math-anchor:calculate'],
    ['migratory-time@migratory-time', 'migratory-time:convert-time-zones'],
    ['context-surface-analyzer@context-surface-analyzer', 'context-surface-analyzer:analyze-context-surface'],
    ['data-transformer@data-transformer-local', 'data-transformer:data-transformer'],
    ['armorial@openadam-local', 'armorial:icon-svg-select'],
    ['laniakea@laniakea', 'laniakea:organize-mind-maps'],
    ['projective@projective-local', 'projective:projective'],
    ['equatorium@equatorium', 'equatorium:interpret-standard-expressions'],
    ['file-vitals@file-vitals-local', 'file-vitals:file-vitals'],
  ]).get(pluginId)
}

try {
  await mkdir(outputRoot, { recursive: true })
  const listed = await run('codex', ['plugin', 'list', '--json'])
  if (listed.status !== 0) throw new Error('could not list installed Codex plugins')
  const plugins = JSON.parse(listed.stdout).installed
  for (const pluginId of localPlugins) {
    const plugin = plugins.find((item) => item.pluginId === pluginId)
    if (plugin === undefined || plugin.enabled !== true) throw new Error(`required installed plugin is unavailable: ${pluginId}`)
    if (plugin.marketplaceSource?.sourceType !== 'local' || typeof plugin.marketplaceSource.source !== 'string' || plugin.marketplaceSource.source.includes('/tools-dev/')) {
      throw new Error(`experiment requires an installed private local marketplace: ${pluginId}`)
    }
  }
  const conditions = [
    { id: 'standard', enabled: standardPlugins, profile: `agent-host-cost-standard-${process.pid}` },
    { id: 'local-dogfood', enabled: localPlugins, profile: `agent-host-cost-local-${process.pid}` },
  ]
  for (const condition of conditions) {
    const path = join(profileRoot, `${condition.profile}.config.toml`)
    await writeFile(path, profileDocument(condition.enabled), { flag: 'wx', mode: 0o600 })
    profilePaths.push(path)
    const promptInput = await run('codex', ['-p', condition.profile, 'debug', 'prompt-input', '只回复收到'], { cwd: suiteRoot })
    if (promptInput.status !== 0) throw new Error(`could not verify the ${condition.id} Codex profile`)
    for (const pluginId of localPlugins) {
      const present = promptInput.stdout.includes(pluginSkillMarker(pluginId))
      if (present !== condition.enabled.has(pluginId)) throw new Error(`${condition.id} profile did not isolate ${pluginId}`)
    }
  }
  const results = []

  for (const condition of conditions) {
    for (const task of tasks) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const args = ['exec', '--json', '--ephemeral', '--ignore-rules', '-p', condition.profile, '-m', model, '-s', 'read-only', '-C', suiteRoot, '--skip-git-repo-check', task.prompt]
        const startedAt = Date.now()
        const execution = await run('codex', args, { cwd: suiteRoot })
        const summary = summarizeEvents(execution.stdout)
        results.push({
          condition: condition.id,
          task: task.id,
          repetition,
          status: execution.status,
          passed: execution.status === 0 && assessCostExperimentTask(task, summary),
          latencyMs: Date.now() - startedAt,
          usage: summary.usage,
          toolSequence: summary.toolSequence,
          toolCallCount: summary.toolCallCount,
          finalSha256: summary.finalSha256,
          stderrWarnings: execution.stderr.split('\n').filter((line) => /WARN|warning/iu.test(line)).length,
        })
        process.stdout.write(`${condition.id}/${task.id}/${repetition}: ${results.at(-1).passed ? 'PASS' : 'FAIL'}\n`)
      }
    }
  }

  const document = {
    schemaVersion: 'openadam.agent-host-cost-experiment.v0.1',
    generatedAt: new Date().toISOString(),
    model,
    repetitions,
    isolation: 'ephemeral Codex tasks with verified temporary profile overlays; base user config unchanged',
    fixedCorpus: tasks.map(({ id, expected }) => ({ id, expected })),
    conditions: conditions.map((condition) => ({ id: condition.id, enabledPlugins: [...condition.enabled].sort() })),
    results,
  }
  const destination = join(outputRoot, 'latest.json')
  await writeFile(destination, `${JSON.stringify(document, null, 2)}\n`)
  process.stdout.write(`${destination}\n`)
  if (results.some((result) => !result.passed)) process.exitCode = 1
} finally {
  await Promise.all(profilePaths.map((path) => rm(path, { force: true })))
}
