import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { asPublicError, AgentHostError } from './errors.mjs'
import { addHost, hostStatus, removeHost, rollbackInstallation, setActiveTools, toolSetStatus, uninstallInstallation, updateInstallation } from './lifecycle.mjs'
import { disableObservability, enableObservability, exportObservabilityTrace, observabilityTraceSources, readCurrentObservability } from './observability.mjs'
import { operationsSnapshot } from './operations-snapshot.mjs'
import { resolveStateRoot } from './paths.mjs'
import { setup } from './setup.mjs'
import { loadState, readStatePaths } from './state.mjs'
import { cleanupStorage } from './storage.mjs'
import { usageSummary } from './usage-summary.mjs'
import { readManagerPreferences, setManagerLanguage } from './manager-preferences.mjs'

const REQUEST_LIMIT = 8 * 1024
const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000
const HOSTS = new Set(['zcode', 'codex', 'claude'])
const PROFILES = new Set(['standard', 'developer', 'observability'])
const TRACE_SOURCE_CATALOG_VERSION = 'openadam.agent-host-trace-source-catalog.v0.1'
const RETAINED_TRACE_PACK_VERSION = 'openadam.agent-host-trace-analysis-pack.v0.2'
const SESSION_HASH = /^[a-f0-9]{64}$/u

function fixedEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(body)
}

function html(response, body) {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  response.end(body)
}

function traceDownload(response, body, filename) {
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

async function bodyJson(request) {
  let body = Buffer.alloc(0)
  for await (const chunk of request) {
    body = Buffer.concat([body, chunk])
    if (body.length > REQUEST_LIMIT) throw new AgentHostError('MANAGER_REQUEST_TOO_LARGE', 'The Manager request is too large')
  }
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new AgentHostError('MANAGER_REQUEST_INVALID', 'The Manager request is not valid JSON')
  }
}

async function safeHostStatus(host, stateRoot) {
  try {
    return await hostStatus({ target: host, quick: true, stateRoot })
  } catch (error) {
    return { status: 'error', host, error: asPublicError(error) }
  }
}

async function sharedCurrentObservability(stateRoot) {
  const paths = await readStatePaths(resolveStateRoot(stateRoot))
  const state = await loadState(paths)
  if (state?.observability?.enabled !== true) return null
  try {
    return await readCurrentObservability(state)
  } catch (error) {
    return {
      status: 'unavailable',
      errorCode: error instanceof AgentHostError ? error.code : 'OBSERVABILITY_CURRENT_READ_FAILED',
    }
  }
}

async function dashboard(stateRoot) {
  const currentObservability = await sharedCurrentObservability(stateRoot)
  const [snapshot, usage, tools, preferences, ...hosts] = await Promise.all([
    operationsSnapshot({ stateRoot }, { currentObservability }),
    usageSummary({ stateRoot }, { currentObservability }),
    toolSetStatus({ stateRoot }).catch((error) => ({ status: 'error', error: asPublicError(error) })),
    readManagerPreferences(stateRoot),
    ...['zcode', 'codex', 'claude'].map((host) => safeHostStatus(host, stateRoot)),
  ])
  return {
    schemaVersion: 'openadam.agent-host-manager-dashboard.v0.1',
    status: 'ok',
    generatedAt: new Date().toISOString(),
    snapshot,
    usage,
    tools,
    preferences,
    hosts,
  }
}

function exactObject(value, allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AgentHostError('MANAGER_REQUEST_INVALID', 'The Manager action must be an object')
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new AgentHostError('MANAGER_REQUEST_INVALID', 'The Manager action contains unsupported fields', { fields: unexpected })
  return value
}

async function action(value, stateRoot) {
  exactObject(value, ['action', 'host', 'connected', 'enabled', 'profile', 'tools', 'purgeData', 'language'])
  if (typeof value.action !== 'string') throw new AgentHostError('MANAGER_REQUEST_INVALID', 'The Manager action is missing')
  if (value.action === 'setup') {
    if (!HOSTS.has(value.host) || !PROFILES.has(value.profile)) throw new AgentHostError('MANAGER_REQUEST_INVALID', 'Choose a supported Agent app and tool set')
    return setup({
      stateRoot,
      profile: value.profile,
      hosts: [value.host],
      enableObservability: value.profile === 'observability',
      dryRun: false,
      noService: false,
    })
  }
  if (value.action === 'monitoring') {
    if (typeof value.enabled !== 'boolean') throw new AgentHostError('MANAGER_REQUEST_INVALID', 'Monitoring requires one explicit on or off value')
    return value.enabled ? enableObservability({ stateRoot }) : disableObservability({ stateRoot })
  }
  if (value.action === 'host') {
    if (!HOSTS.has(value.host) || typeof value.connected !== 'boolean') throw new AgentHostError('MANAGER_REQUEST_INVALID', 'Choose one supported Agent app and connection state')
    return value.connected ? addHost({ stateRoot, target: value.host }) : removeHost({ stateRoot, target: value.host })
  }
  if (value.action === 'tools') {
    if (!Array.isArray(value.tools) || value.tools.length === 0 || value.tools.some((item) => typeof item !== 'string')) {
      throw new AgentHostError('MANAGER_REQUEST_INVALID', 'Choose at least one installed Agent tool')
    }
    return setActiveTools({ stateRoot, tools: [...new Set(value.tools)] })
  }
  if (value.action === 'update') return updateInstallation({ stateRoot, dryRun: false })
  if (value.action === 'rollback') return rollbackInstallation({ stateRoot, dryRun: false })
  if (value.action === 'cleanup') return cleanupStorage({ stateRoot })
  if (value.action === 'uninstall') {
    if (typeof value.purgeData !== 'boolean') throw new AgentHostError('MANAGER_REQUEST_INVALID', 'Uninstall requires an explicit data choice')
    return uninstallInstallation({ stateRoot, purgeData: value.purgeData })
  }
  if (value.action === 'preferences') return setManagerLanguage(stateRoot, value.language)
  throw new AgentHostError('MANAGER_REQUEST_INVALID', `Unsupported Manager action: ${value.action}`)
}

function integerQuery(value, name, minimum, maximum) {
  if (value === null) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AgentHostError('MANAGER_REQUEST_INVALID', `${name} is outside the supported range`)
  }
  return parsed
}

async function traceSources(url, stateRoot, reader) {
  const unexpected = [...url.searchParams.keys()].filter((key) => !['provider', 'fromMs', 'toMs', 'limit'].includes(key))
  if (unexpected.length > 0) throw new AgentHostError('MANAGER_REQUEST_INVALID', 'The trace query contains unsupported fields', { fields: unexpected })
  const provider = url.searchParams.get('provider')
  if (typeof provider !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(provider)) {
    throw new AgentHostError('MANAGER_REQUEST_INVALID', 'Choose one trace provider')
  }
  const catalog = await reader({
    stateRoot,
    provider,
    fromMs: integerQuery(url.searchParams.get('fromMs'), 'fromMs', 0, Number.MAX_SAFE_INTEGER),
    toMs: integerQuery(url.searchParams.get('toMs'), 'toMs', 0, Number.MAX_SAFE_INTEGER),
    limit: integerQuery(url.searchParams.get('limit'), 'limit', 1, 50) ?? 25,
  })
  const privacy = catalog?.privacy
  const sourcesValid = Array.isArray(catalog?.sources) && catalog.sources.every((source) => (
    SESSION_HASH.test(source?.sessionHash)
    && Number.isSafeInteger(source?.totalEvents) && source.totalEvents >= 1
    && Number.isSafeInteger(source?.lastEventAtMs) && source.lastEventAtMs >= 0
    && source?.completeness === 'unknown'
  ))
  if (catalog?.schemaVersion !== TRACE_SOURCE_CATALOG_VERSION
    || catalog?.status !== 'ok'
    || catalog?.provider !== provider
    || catalog?.interpretationStatus !== 'not-performed'
    || privacy?.contentPolicy !== 'metadata-only'
    || privacy?.sourcePathIncluded !== false
    || privacy?.rawConversationContentIncluded !== false
    || privacy?.toolArgumentsIncluded !== false
    || privacy?.toolResultsIncluded !== false
    || !sourcesValid) {
    throw new AgentHostError('TRACE_SOURCE_CATALOG_INVALID', 'The monitoring component returned an invalid retained trace catalog')
  }
  return catalog
}

function validateRetainedTraceDownload(receipt, body, output, provider, session) {
  let pack
  try {
    pack = JSON.parse(body.toString('utf8'))
  } catch {
    throw new AgentHostError('TRACE_EXPORT_CONTENT_INVALID', 'The retained trace export is not valid JSON')
  }
  const privacy = pack?.privacy
  const countsValid = Number.isSafeInteger(receipt?.eventsReturned)
    && receipt.eventsReturned >= 0
    && Number.isSafeInteger(receipt?.eventsAvailable)
    && receipt.eventsAvailable >= receipt.eventsReturned
    && receipt.eventsReturned === pack?.limits?.eventsReturned
    && receipt.eventsAvailable === pack?.limits?.eventsAvailable
    && Array.isArray(pack?.events)
    && pack.events.length === receipt.eventsReturned
  if (receipt?.status !== 'completed'
    || receipt?.schemaVersion !== RETAINED_TRACE_PACK_VERSION
    || receipt?.outputPath !== output
    || receipt?.outputBytes !== body.length
    || receipt?.contentPolicy !== 'metadata-only'
    || receipt?.observerPackRetained !== false
    || receipt?.sourcePathStoredInPack !== false
    || receipt?.interpretationStatus !== 'not-performed'
    || pack?.schemaVersion !== RETAINED_TRACE_PACK_VERSION
    || pack?.source?.provider !== provider
    || pack?.source?.selectionKind !== 'observer-retained-session'
    || pack?.source?.sessionHash !== session
    || privacy?.contentPolicy !== 'metadata-only'
    || privacy?.selectedConversationContentIncluded !== false
    || privacy?.sensitiveContentConfirmed !== false
    || privacy?.transportSecretsExcluded !== true
    || privacy?.selectedContentMayContainUserSecrets !== false
    || privacy?.observerPackRetained !== false
    || privacy?.sourceUsesObserverRetainedMetadata !== true
    || privacy?.sourcePathIncluded !== false
    || privacy?.toolArgumentsIncluded !== false
    || privacy?.toolResultsIncluded !== false
    || pack?.interpretationStatus !== 'not-performed'
    || !countsValid) {
    throw new AgentHostError('TRACE_EXPORT_CONTENT_INVALID', 'The monitoring component returned an invalid retained trace export')
  }
}

async function exportTraceDownload(value, stateRoot, exporter, signal) {
  exactObject(value, ['provider', 'session', 'fromMs', 'toMs'])
  if (typeof value.provider !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value.provider)) {
    throw new AgentHostError('MANAGER_REQUEST_INVALID', 'Choose one trace provider')
  }
  if (typeof value.session !== 'string' || !/^[a-f0-9]{64}$/u.test(value.session)) {
    throw new AgentHostError('MANAGER_REQUEST_INVALID', 'Choose one retained trace session')
  }
  for (const [name, selected] of [['fromMs', value.fromMs], ['toMs', value.toMs]]) {
    if (selected !== undefined && (!Number.isSafeInteger(selected) || selected < 0)) {
      throw new AgentHostError('MANAGER_REQUEST_INVALID', `${name} is outside the supported range`)
    }
  }
  if (value.fromMs !== undefined && value.toMs !== undefined && value.fromMs > value.toMs) {
    throw new AgentHostError('MANAGER_REQUEST_INVALID', 'The trace range start must not be after its end')
  }
  const temporary = await mkdtemp(join(tmpdir(), 'agent-host-trace-download-'))
  const output = join(temporary, 'trace-pack.json')
  try {
    const receipt = await exporter({
      stateRoot,
      provider: value.provider,
      session: value.session,
      output,
      fromMs: value.fromMs,
      toMs: value.toMs,
      maxEvents: 500,
      maxOutputBytes: 8 * 1024 * 1024,
      signal,
    })
    const body = await readFile(output)
    validateRetainedTraceDownload(receipt, body, output, value.provider, value.session)
    return {
      body,
      filename: `agent-host-${value.provider}-trace-${value.session.slice(0, 12)}.json`,
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

function openBrowser(url) {
  const command = platform() === 'win32' ? 'cmd.exe' : platform() === 'darwin' ? '/usr/bin/open' : 'xdg-open'
  const args = platform() === 'win32' ? ['/d', '/s', '/c', 'start', '""', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

function cookieToken(request) {
  const match = String(request.headers.cookie ?? '').match(/(?:^|;\s*)agent_host_manager=([A-Za-z0-9_-]+)/u)
  return match?.[1] ?? null
}

function managerDocument() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Host</title><style>
:root{color-scheme:light dark;font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f6f8;color:#15171a}*{box-sizing:border-box}body{margin:0}button,select{font:inherit}.shell{display:grid;grid-template-columns:230px 1fr;min-height:100vh}.side{padding:28px 18px;background:#111318;color:#f7f7f8}.brand{font-size:20px;font-weight:700;margin:0 10px 28px}.nav{display:grid;gap:6px}.nav button,.side-footer button{border:0;background:transparent;color:#aeb4bf;text-align:left;padding:10px 12px;border-radius:9px}.nav button[aria-current=true]{background:#292d35;color:white}.nav button:focus-visible,.side-footer button:focus-visible,button.action:focus-visible,select:focus-visible{outline:3px solid #75a9ff;outline-offset:2px}.side-footer{position:fixed;bottom:16px;margin-left:10px;display:grid;gap:2px}.side-footer button{padding:4px 0;font-size:12px}.version{color:#777f8c;font-size:12px}.main{padding:36px;max-width:1080px;width:100%}h1{font-size:30px;margin:0}h2{font-size:17px;margin:0 0 14px}.sub{color:#69707b;margin:4px 0 26px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px}.card{background:white;border:1px solid #e2e5e9;border-radius:14px;padding:18px;margin-bottom:16px;box-shadow:0 1px 2px #00000008}.metric{font-size:25px;font-weight:700}.muted{color:#747b86}.row{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid #eceef1}.row:first-of-type{border-top:0}.row .grow{flex:1}.pill{font-size:12px;padding:3px 8px;border-radius:20px;background:#edf5ee;color:#26733a}.pill.warn{background:#fff2de;color:#995500}button.action{border:1px solid #cfd4da;background:#fff;color:#17191c;padding:8px 12px;border-radius:9px}button.primary{background:#1769e0;border-color:#1769e0;color:#fff}button.danger{color:#b42318}button:disabled{opacity:.5}.actions{display:flex;gap:10px;flex-wrap:wrap}.actions select{min-width:180px;padding:8px;border:1px solid #cfd4da;border-radius:9px;background:transparent;color:inherit}.hidden{display:none!important}.notice{padding:12px 14px;border-radius:10px;background:#fff4df;color:#7a4c00;margin-bottom:16px}.empty{padding:70px 20px;text-align:center;color:#737a84}.check{display:flex;gap:8px;align-items:center}.tool-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 18px}.heat{display:grid;grid-template-columns:repeat(30,minmax(5px,1fr));gap:4px;margin:12px 0 4px}.heat i{display:block;aspect-ratio:1;border-radius:3px;background:#d9e5f7}.heat i.on{background:#1769e0}dialog{width:min(420px,calc(100% - 32px));border:1px solid #d9dde3;border-radius:14px;padding:20px;background:#fff;color:#17191c}dialog::backdrop{background:#11131888}.setting-row{display:grid;gap:7px;margin:20px 0}.setting-row select{width:100%;padding:8px;border:1px solid #cfd4da;border-radius:9px;background:transparent}.busy{position:fixed;inset:0;background:#ffffffaa;display:grid;place-items:center;backdrop-filter:blur(2px)}.busy div{background:#111318;color:white;padding:14px 20px;border-radius:12px}@media(max-width:760px){.shell{grid-template-columns:1fr;grid-template-rows:auto 1fr}.side{padding:15px}.brand{margin-bottom:12px}.nav{grid-template-columns:repeat(4,1fr)}.nav button{text-align:center;padding:8px 4px;font-size:12px}.side-footer{position:absolute;right:14px;top:11px;bottom:auto;margin:0}.side-footer button{padding:4px 8px}.version{display:none}.main{padding:22px}.heat{grid-template-columns:repeat(15,minmax(7px,1fr))}}
@media(prefers-color-scheme:dark){:root{background:#0d0f12;color:#f1f2f4}.side{background:#08090b}.card,dialog{background:#17191e;border-color:#2b2f36;color:#f1f2f4}.row{border-color:#2b2f36}button.action,.setting-row select{background:#202329;border-color:#3a3f48;color:#f1f2f4}.muted,.sub{color:#9da4af}.busy{background:#0d0f12aa}}
</style></head><body><div class="shell"><aside class="side"><div class="brand">Agent Host</div><nav class="nav" id="nav"><button data-page="environment" aria-current="true"></button><button data-page="tools"></button><button data-page="usage"></button><button data-page="activity"></button></nav><div class="side-footer"><button id="refreshButton"></button><button id="settingsButton"></button><div class="version" id="version"></div></div></aside><main class="main"><div id="error" class="notice hidden" role="alert"></div><section id="environment"></section><section id="tools" class="hidden"></section><section id="usage" class="hidden"></section><section id="activity" class="hidden"></section></main></div><dialog id="settingsDialog"><h2 id="settingsTitle"></h2><label class="setting-row"><span id="languageLabel"></span><select id="languageSelect"></select></label><div class="actions"><button class="action primary" id="settingsDone"></button></div></dialog><div id="busy" class="busy hidden" role="status" aria-live="polite"><div id="busyText"></div></div>
<script>
const $=s=>document.querySelector(s),el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};let data,languageSelection='system',changing=false;
const names={zcode:'ZCode',codex:'Codex',claude:'Claude Code','deepseek-harness':'DeepSeek Harness','gemini-cli':'Gemini CLI','github-copilot-cli':'GitHub Copilot CLI'};
const zh={
  'Refresh':'刷新','Refreshing…':'正在刷新…','Change completed; the current status could not be refreshed. Use Refresh to try again.':'更改已完成，但当前状态刷新失败。请点击“刷新”重试。','The request ended without a confirmed result. Refresh the environment before repeating the action.':'请求结束，但未能确认操作结果。请先刷新环境，再决定是否重试操作。','Completed with a warning: {message}':'已完成，但有一项提醒：{message}','Installed tools':'已安装工具','This environment has no Agent tools to activate. Its developer Skill remains available.':'此环境没有需要启用的 Agent 工具，开发者 Skill 仍然可用。','Choose at least one installed tool.':'请至少选择一个已安装工具。','Tool profile':'工具配置','Agent app':'Agent 应用','Trace provider':'轨迹来源',
  'Environment':'环境','Tools':'工具','Usage':'使用情况','Activity':'活动','Settings':'设置','Language':'语言','System default':'跟随系统','English':'English','Simplified Chinese':'简体中文','Done':'完成','Working…':'处理中…','Saving language…':'正在保存语言…',
  'Agent environment':'Agent 环境','Installed locally on this PC':'已安装在这台电脑上','Set up a compatible local tool environment':'设置兼容的本地工具环境','Set up tools':'设置工具','Standard tools':'标准工具','Developer Kit':'开发者 Kit','Standard + monitoring':'标准工具 + 监控','Set up':'设置','Setting up tools…':'正在设置工具…',
  'Installed components':'已安装组件','Connected Agent apps':'已连接的 Agent 应用','Allocated bytes':'占用空间（字节）','Local monitoring':'本地监控','On':'已开启','Off':'已关闭','Agent apps':'Agent 应用','Not installed':'未安装','Connected':'已连接','Available':'可连接','Disconnect':'断开连接','Connect':'连接','Disconnecting…':'正在断开连接…','Connecting…':'正在连接…',
  'Tool environment actions':'工具环境操作','Update tools':'更新工具','Restore previous tools':'恢复上一版工具','Clean old packages':'清理旧软件包','Disconnect, keep data':'断开并保留数据','Disconnect, remove Host data':'断开并移除 Host 数据','Updating tools…':'正在更新工具…','Restoring tools…':'正在恢复工具…','Cleaning storage…':'正在清理存储…','Disconnecting tools…':'正在断开工具…','Disconnect tools and remove Agent Host private Suite data? Observer history remains separately owned.':'断开工具并移除 Agent Host 私有数据？Observer 历史记录仍由其独立保留。','On Windows, application restore and uninstall are also available in the openAdam Start menu folder.':'在 Windows 上，也可从“开始”菜单的 openAdam 文件夹恢复或卸载应用。',
  'Choose which installed tools are available to fresh Agent tasks.':'选择新 Agent 任务可以使用哪些已安装工具。','No Agent environment is installed.':'尚未安装 Agent 环境。','Available tools':'可用工具','Changes take effect in a fresh Agent task.':'更改会在新的 Agent 任务中生效。','Apply tool set':'应用工具集',
  'Usage & Reliability':'使用情况与可靠性','Local monitoring is off':'本地监控已关闭','{days} day local metadata window':'最近 {days} 天的本地元数据','Monitoring':'监控','Collect metadata-only activity, Token, and runtime outcome observations. No prompts, arguments, results, source paths, network calls, or model calls are used.':'仅采集活动、Token 与运行结果的元数据。不使用提示词、参数、结果、源码路径、网络请求或模型调用。','Turn on monitoring':'开启监控','Turning on monitoring…':'正在开启监控…','Live snapshots are unavailable; showing the last completed refresh.':'实时快照不可用，当前显示上次完成的刷新结果。',
  'Measured tool calls':'已测量工具调用','Completed':'已完成','Errors':'错误','Cancelled':'已取消','Provider-reported Tokens':'Provider 报告的 Token','Peak observed UTC day':'单日 Token 峰值（UTC）','Observed sessions':'已观测会话','Observed turns':'已观测轮次','Current UTC-day streak':'当前连续活跃天数（UTC）','Longest UTC-day streak':'最长连续活跃天数（UTC）','{date} · {tokens} Tokens · {calls} tool calls':'{date} · {tokens} Token · {calls} 次工具调用','{days} active UTC days · longest session metadata span is not chat duration.':'{days} 个活跃 UTC 日；最长会话元数据跨度不等于聊天时长。','Agent activity':'Agent 活动','No supported Agent activity was observed.':'未观测到受支持的 Agent 活动。','Most used Agent Host tools':'最常用的 Agent Host 工具','Unknown':'未知','{calls} calls · {errors} errors · {cancelled} cancelled':'{calls} 次调用 · {errors} 次错误 · {cancelled} 次取消','No mapped calls were observed.':'未观测到已映射的调用。','Counts do not establish Skill activation, non-use reasons, adoption, correctness, task quality, or value. Provider Token semantics remain separate.':'这些计数不能证明 Skill 已激活、未使用原因、结果采纳、正确性、任务质量或价值；不同 Provider 的 Token 语义仍分别呈现。','Turn off monitoring':'关闭监控','Turning off monitoring…':'正在关闭监控…','Agent trace coverage':'Agent 轨迹覆盖','Model steps':'模型步骤','Tool offers':'工具已提供','Trace tool calls':'轨迹工具调用','Trace tool results':'轨迹工具结果','Turn endings':'轮次结束','Public events':'公开事件','Official hooks':'官方 Hook','Local records':'本机记录','Aggregate usage':'聚合用量','Current':'当前','Partial':'部分','Needs attention':'需要处理','Not configured':'未配置','Offered, called, and returned are separate recorded facts. They do not establish why a tool was chosen, whether its result was adopted, or whether the work was correct.':'工具已提供、已调用和已返回是彼此独立的记录事实；它们不能说明为何选择工具、结果是否被采纳，也不能证明工作正确。','Trace sessions':'轨迹会话','Load sessions':'加载会话','Loading trace sessions…':'正在加载轨迹会话…','Export metadata':'导出元数据','Preparing trace export…':'正在准备轨迹导出…','No retained sessions for this provider.':'此 Provider 没有保留的会话。','Retained metadata may be partial because older observations expire and monitoring may have started mid-session.':'由于较早观测会过期，而且监控可能在会话中途启用，因此保留的元数据可能不完整。','{events} events · last observed {date}':'{events} 个事件 · 最近观测于 {date}','Trace export failed':'轨迹导出失败','Trace session list failed':'轨迹会话列表加载失败',
  'No retained trace metadata matches this provider and session':'没有与此 Provider 和会话匹配的保留轨迹元数据。','The retained session has no events in the requested time range':'保留的会话在所选时间范围内没有事件。','Observer trace metadata schema is unavailable':'Observer 的轨迹元数据结构不可用。','Observability is not enabled':'本地监控尚未开启。',
  'Changes made to this environment':'此环境的变更','Recent changes':'最近变更','No lifecycle changes yet.':'尚无生命周期变更。','Agent Host is unavailable':'Agent Host 当前不可用','The action failed':'操作失败'
};
function activeLanguage(){if(languageSelection==='zh-Hans')return'zh-Hans';if(languageSelection==='en')return'en';return(navigator.languages?.[0]||navigator.language||'en').toLowerCase().startsWith('zh')?'zh-Hans':'en'}
function t(key){return activeLanguage()==='zh-Hans'?(zh[key]||key):key}
function f(key,values){let value=t(key);for(const[name,replacement]of Object.entries(values))value=value.replaceAll('{'+name+'}',String(replacement));return value}
function number(v){if(v==null)return'—';if(typeof v!=='number'&&typeof v!=='bigint')return String(v);return new Intl.NumberFormat(activeLanguage()==='zh-Hans'?'zh-CN':'en-US').format(v)}
function applyChrome(){document.documentElement.lang=activeLanguage()==='zh-Hans'?'zh-Hans':'en';for(const b of document.querySelectorAll('#nav button'))b.textContent=t({environment:'Environment',tools:'Tools',usage:'Usage',activity:'Activity'}[b.dataset.page]);$('#settingsButton').textContent=t('Settings');$('#refreshButton').textContent=t('Refresh');$('#settingsTitle').textContent=t('Settings');$('#languageLabel').textContent=t('Language');$('#settingsDone').textContent=t('Done');const select=$('#languageSelect'),selected=languageSelection;select.replaceChildren();for(const[id,label]of[['system','System default'],['en','English'],['zh-Hans','Simplified Chinese']]){const o=el('option',t(label));o.value=id;o.selected=id===selected;select.append(o)}}
function card(title){const c=el('div',undefined,'card');c.append(el('h2',t(title)));return c}
function row(label,value){const r=el('div',undefined,'row');r.append(el('div',label,'grow'),el('div',value));return r}
function button(label,run,cls='action'){const b=el('button',t(label),cls);b.onclick=run;return b}
function setPage(page){for(const s of document.querySelectorAll('main section'))s.classList.toggle('hidden',s.id!==page);for(const b of document.querySelectorAll('#nav button'))b.setAttribute('aria-current',b.dataset.page===page)}
for(const b of document.querySelectorAll('#nav button'))b.onclick=()=>setPage(b.dataset.page);
$('#settingsButton').onclick=()=>$('#settingsDialog').showModal();$('#settingsDone').onclick=()=>$('#settingsDialog').close();$('#languageSelect').onchange=()=>call({action:'preferences',language:$('#languageSelect').value},t('Saving language…'));
function notice(message){$('#error').textContent=message;$('#error').classList.toggle('hidden',!message)}
function busy(active,label){changing=active;$('#busyText').textContent=label||'';$('#busy').classList.toggle('hidden',!active);$('.shell').inert=active;$('#settingsDialog').inert=active}
function acceptDashboard(value){data=value;languageSelection=data.preferences?.language||'system';render()}
async function call(action,label){
  if(changing)return;
  busy(true,label);notice('');let confirmed=false;
  try{
    const r=await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action)});
    const v=await r.json();
    if(!r.ok){notice(v.error?.message||t('The action failed'));return}
    confirmed=true;
    if(action.action==='preferences'){languageSelection=action.language;applyChrome()}
    if(v.dashboard)acceptDashboard(v.dashboard);
    const warnings=(v.result?.warnings||[]).slice(0,8).map(w=>f('Completed with a warning: {message}',{message:w.message||w.code}));
    if(v.refreshError||!v.dashboard)warnings.push(t('Change completed; the current status could not be refreshed. Use Refresh to try again.'));
    notice(warnings.join(' '));
  }catch{
    notice(t(confirmed?'Change completed; the current status could not be refreshed. Use Refresh to try again.':'The request ended without a confirmed result. Refresh the environment before repeating the action.'));
  }finally{busy(false)}
}
async function refresh(){if(changing)return;busy(true,t('Refreshing…'));try{await load();notice('')}catch(e){notice(e.message)}finally{busy(false)}}
$('#refreshButton').onclick=refresh;
async function load(){const r=await fetch('/api/dashboard');if(!r.ok)throw new Error(t('Agent Host is unavailable'));acceptDashboard(await r.json())}
function render(){applyChrome();const s=data.snapshot,u=data.usage;$('#version').textContent=s.configured?s.environment.suiteVersion:'';renderEnvironment(s,u);renderTools(data.tools);renderUsage(u);renderActivity(s.recentActivity||[])}
function renderEnvironment(s,u){const root=$('#environment');root.replaceChildren();root.append(el('h1',t('Agent environment')),el('p',t(s.configured?'Installed locally on this PC':'Set up a compatible local tool environment'),'sub'));if(!s.configured){const c=card('Set up tools');const p=el('select');p.setAttribute('aria-label',t('Agent app'));for(const id of['zcode','codex','claude']){const o=el('option',names[id]);o.value=id;p.append(o)}const profile=el('select');profile.setAttribute('aria-label',t('Tool profile'));for(const[id,label]of[['standard','Standard tools'],['developer','Developer Kit'],['observability','Standard + monitoring']]){const o=el('option',t(label));o.value=id;profile.append(o)}const a=el('div',undefined,'actions');a.append(p,profile,button('Set up',()=>call({action:'setup',host:p.value,profile:profile.value},t('Setting up tools…')),'action primary'));c.append(a);root.append(c);return}const grid=el('div',undefined,'grid');for(const[value,label]of[[(s.environment.availableAgentComponents||[]).length,'Installed tools'],[Object.keys(s.environment.hosts).length,'Connected Agent apps'],[s.storage?.allocatedBytes,'Allocated bytes'],[u.enabled?t('On'):t('Off'),'Local monitoring']]){const c=card(label);c.append(el('div',number(value),'metric'));grid.append(c)}root.append(grid);const hc=card('Agent apps');for(const h of data.hosts){const connected=Boolean(s.environment.hosts[h.host]);const r=row(names[h.host],t(h.appInstalled===false?'Not installed':connected?'Connected':'Available'));r.append(button(connected?'Disconnect':'Connect',()=>call({action:'host',host:h.host,connected:!connected},t(connected?'Disconnecting…':'Connecting…'))));hc.append(r)}root.append(hc);const ops=card('Tool environment actions');const a=el('div',undefined,'actions');a.append(button('Update tools',()=>call({action:'update'},t('Updating tools…'))),button('Restore previous tools',()=>call({action:'rollback'},t('Restoring tools…'))),button('Clean old packages',()=>call({action:'cleanup'},t('Cleaning storage…'))),button('Disconnect, keep data',()=>call({action:'uninstall',purgeData:false},t('Disconnecting tools…')),'action danger'),button('Disconnect, remove Host data',()=>{if(confirm(t('Disconnect tools and remove Agent Host private Suite data? Observer history remains separately owned.')))call({action:'uninstall',purgeData:true},t('Disconnecting tools…'))},'action danger'));ops.append(a,el('p',t('On Windows, application restore and uninstall are also available in the openAdam Start menu folder.'),'muted'));root.append(ops)}
function renderTools(value){
  const root=$('#tools');root.replaceChildren(el('h1',t('Tools')),el('p',t('Choose which installed tools are available to fresh Agent tasks.'),'sub'));
  if(value.status==='error'){root.append(el('div',t('No Agent environment is installed.'),'empty'));return}
  const c=card('Available tools'),available=value.availableAgentComponents||[];
  if(!available.length){c.append(el('p',t('This environment has no Agent tools to activate. Its developer Skill remains available.'),'muted'));root.append(c);return}
  const form=el('div',undefined,'tool-grid'),hint=el('p',undefined,'muted');
  const selected=()=>[...form.querySelectorAll('input:checked')].map(x=>x.value);
  const apply=button('Apply tool set',()=>call({action:'tools',tools:selected()},t('Updating tools…')),'action primary');
  const update=()=>{const ids=selected();apply.disabled=!ids.length||JSON.stringify([...ids].sort())===JSON.stringify([...(value.activeAgentComponents||[])].sort());hint.textContent=t(ids.length?'Changes take effect in a fresh Agent task.':'Choose at least one installed tool.')};
  for(const id of available){const label=el('label',undefined,'check'),box=document.createElement('input');box.type='checkbox';box.value=id;box.checked=(value.activeAgentComponents||[]).includes(id);box.onchange=update;label.append(box,el('span',value.components?.[id]?.displayName||id));form.append(label)}
  c.append(form,hint,apply);root.append(c);update();
}
async function downloadTrace(provider,session){$('#busyText').textContent=t('Preparing trace export…');$('#busy').classList.remove('hidden');$('#error').classList.add('hidden');try{const r=await fetch('/api/trace-export',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider,session})});if(!r.ok){const v=await r.json();throw new Error(t(v.error?.message||'Trace export failed'))}const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='agent-host-'+provider+'-trace-'+session.slice(0,12)+'.json';document.body.append(a);a.click();a.remove();URL.revokeObjectURL(url)}catch(e){$('#error').textContent=e.message;$('#error').classList.remove('hidden')}finally{$('#busy').classList.add('hidden')}}
async function loadTraceSessions(provider,container){$('#busyText').textContent=t('Loading trace sessions…');$('#busy').classList.remove('hidden');$('#error').classList.add('hidden');try{const r=await fetch('/api/trace-sources?provider='+encodeURIComponent(provider)+'&limit=25'),v=await r.json();if(!r.ok)throw new Error(t(v.error?.message||'Trace session list failed'));container.replaceChildren();for(const item of v.sources){const line=el('div',undefined,'row'),label=el('div',undefined,'grow');label.append(el('div',(names[provider]||provider)+' · '+item.sessionHash.slice(0,12)+'…'),el('div',f('{events} events · last observed {date}',{events:number(item.totalEvents),date:new Date(item.lastEventAtMs).toLocaleString(activeLanguage()==='zh-Hans'?'zh-CN':'en-US')}),'muted'));line.append(label,button('Export metadata',()=>downloadTrace(provider,item.sessionHash)));container.append(line)}if(!v.sources.length)container.append(el('p',t('No retained sessions for this provider.'),'muted'))}catch(e){container.replaceChildren(el('p',e.message||t('Trace session list failed'),'notice'))}finally{$('#busy').classList.add('hidden')}}
function renderTraceSessions(trace,root){const providers=[...new Set((trace.adapters||[]).map(x=>x.provider).filter(Boolean))];const c=card('Trace sessions');if(!providers.length){c.append(el('p',t('No retained sessions for this provider.'),'muted'));root.append(c);return}const actions=el('div',undefined,'actions'),select=document.createElement('select'),list=el('div');select.setAttribute('aria-label',t('Trace provider'));for(const provider of providers){const option=el('option',names[provider]||provider);option.value=provider;select.append(option)}actions.append(select,button('Load sessions',()=>loadTraceSessions(select.value,list),'action primary'));c.append(actions,el('p',t('Retained metadata may be partial because older observations expire and monitoring may have started mid-session.'),'muted'),list);root.append(c)}
function renderUsage(u){const root=$('#usage');root.replaceChildren(el('h1',t('Usage & Reliability')),el('p',u.enabled?f('{days} day local metadata window',{days:u.windowDays||'—'}):t('Local monitoring is off'),'sub'));if(!u.enabled){const c=card('Monitoring');c.append(el('p',t('Collect metadata-only activity, Token, and runtime outcome observations. No prompts, arguments, results, source paths, network calls, or model calls are used.'),'muted'),button('Turn on monitoring',()=>call({action:'monitoring',enabled:true},t('Turning on monitoring…')),'action primary'));root.append(c);return}if(u.observationSource==='cached-agent-host-refresh')root.append(el('div',t('Live snapshots are unavailable; showing the last completed refresh.'),'notice'));const grid=el('div',undefined,'grid');for(const[v,label]of[[u.reliability.measuredToolCalls,'Measured tool calls'],[u.reliability.completedToolCalls,'Completed'],[u.reliability.toolErrors,'Errors'],[u.reliability.toolCancellations,'Cancelled']]){const c=card(label);c.append(el('div',number(v),'metric'));grid.append(c)}root.append(grid);const trace=u.trace||{adapters:[]},traceCard=card('Agent trace coverage'),traceGrid=el('div',undefined,'grid');for(const[v,label]of[[trace.modelSteps,'Model steps'],[trace.toolOffers,'Tool offers'],[trace.toolCalls,'Trace tool calls'],[trace.toolResults,'Trace tool results'],[trace.turnEnds,'Turn endings']]){const m=el('div');m.append(el('div',number(v),'metric'),el('div',t(label),'muted'));traceGrid.append(m)}traceCard.append(traceGrid);for(const a of trace.adapters||[]){const transport={'public-events':'Public events',opentelemetry:'OpenTelemetry','official-hooks':'Official hooks','stable-local-records':'Local records','aggregate-store':'Aggregate usage'}[a.transport]||'Unknown',status={ok:'Current',partial:'Partial',error:'Needs attention',missing:'Unavailable',unavailable:'Unavailable',unconfigured:'Not configured'}[a.status]||'Unknown';traceCard.append(row((names[a.provider]||a.provider)+' · '+t(transport),t(status)))}traceCard.append(el('p',t('Offered, called, and returned are separate recorded facts. They do not establish why a tool was chosen, whether its result was adopted, or whether the work was correct.'),'muted'));root.append(traceCard);renderTraceSessions(trace,root);for(const a of u.providerActivity){const p=u.providerUsage.find(x=>x.provider===a.provider)||{};const c=card(names[a.provider]||a.provider);const g=el('div',undefined,'grid');for(const[v,label]of[[p.totalTokens,'Provider-reported Tokens'],[p.peakObservedDailyTokens,'Peak observed UTC day'],[a.observedSessions,'Observed sessions'],[a.observedTurns,'Observed turns'],[a.currentObservedDayStreak,'Current UTC-day streak'],[a.longestObservedDayStreak,'Longest UTC-day streak']]){const m=el('div');m.append(el('div',number(v),'metric'),el('div',t(label),'muted'));g.append(m)}c.append(g);const days=u.dailyActivity.entries.filter(x=>x.provider===a.provider).slice(-30),heat=el('div',undefined,'heat'),max=Math.max(1,...days.map(x=>x.totalTokens??x.toolCalls??0));for(const d of days){const i=el('i');const v=d.totalTokens??d.toolCalls??0;i.className=v>0?'on':'';i.style.opacity=String(.2+.8*v/max);i.title=f('{date} · {tokens} Tokens · {calls} tool calls',{date:d.utcDate,tokens:number(d.totalTokens),calls:number(d.toolCalls)});heat.append(i)}c.append(heat,el('p',f('{days} active UTC days · longest session metadata span is not chat duration.',{days:number(a.observedActiveDays)}),'muted'));root.append(c)}if(!u.providerActivity.length){const ac=card('Agent activity');ac.append(el('p',t('No supported Agent activity was observed.'),'muted'));root.append(ac)}const tc=card('Most used Agent Host tools');for(const item of u.tools.entries.slice(0,12))tc.append(row((item.toolName||t('Unknown')).replace(/^mcp__/,'').replaceAll('__',' · '),f('{calls} calls · {errors} errors · {cancelled} cancelled',{calls:number(item.historicalCalls),errors:number(item.errors),cancelled:number(item.cancelled)})));if(!u.tools.entries.length)tc.append(el('p',t('No mapped calls were observed.'),'muted'));tc.append(el('p',t('Counts do not establish Skill activation, non-use reasons, adoption, correctness, task quality, or value. Provider Token semantics remain separate.'),'muted'));root.append(tc);const controls=card('Monitoring');controls.append(button('Turn off monitoring',()=>call({action:'monitoring',enabled:false},t('Turning off monitoring…'))));root.append(controls)}
function renderActivity(items){const root=$('#activity');root.replaceChildren(el('h1',t('Activity')),el('p',t('Changes made to this environment'),'sub'));const c=card('Recent changes');for(const item of items)c.append(row(item.summary,new Date(item.occurredAt).toLocaleString(activeLanguage()==='zh-Hans'?'zh-CN':'en-US')));if(!items.length)c.append(el('p',t('No lifecycle changes yet.'),'muted'));root.append(c)}
applyChrome();load().catch(e=>{$('#error').textContent=e.message;$('#error').classList.remove('hidden')});
</script></body></html>`
}

export async function startWebManager(options = {}) {
  const stateRoot = options.stateRoot
  const token = randomBytes(32).toString('base64url')
  let origin
  let idleTimer
  const traceSourceReader = options.traceSourceReader ?? observabilityTraceSources
  const traceExporter = options.traceExporter ?? exportObservabilityTrace
  const touch = (server) => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => server.close(), options.idleTimeoutMs ?? IDLE_TIMEOUT_MS)
    idleTimer.unref()
  }
  const server = createServer(async (request, response) => {
    touch(server)
    try {
      const url = new URL(request.url ?? '/', origin)
      if (request.method === 'GET' && url.pathname === `/auth/${token}`) {
        response.writeHead(303, {
          location: '/',
          'set-cookie': `agent_host_manager=${token}; HttpOnly; SameSite=Strict; Path=/`,
          'cache-control': 'no-store',
        })
        response.end()
        return
      }
      if (!fixedEqual(cookieToken(request) ?? '', token)) {
        json(response, 401, { status: 'error', error: { code: 'MANAGER_UNAUTHORIZED', message: 'Open Agent Host from its installed shortcut.' } })
        return
      }
      if (request.method === 'GET' && url.pathname === '/') {
        html(response, managerDocument())
        return
      }
      if (request.method === 'GET' && url.pathname === '/favicon.ico') {
        response.writeHead(204, { 'cache-control': 'no-store' })
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/dashboard') {
        json(response, 200, await dashboard(stateRoot))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/trace-sources') {
        json(response, 200, await traceSources(url, stateRoot, traceSourceReader))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/trace-export') {
        if (request.headers.origin !== origin || !String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          json(response, 403, { status: 'error', error: { code: 'MANAGER_ORIGIN_REJECTED', message: 'The Manager export did not come from this local app.' } })
          return
        }
        const controller = new AbortController()
        const cancel = () => controller.abort()
        request.once('aborted', cancel)
        response.once('close', cancel)
        try {
          const exported = await exportTraceDownload(await bodyJson(request), stateRoot, traceExporter, controller.signal)
          traceDownload(response, exported.body, exported.filename)
        } finally {
          request.off('aborted', cancel)
          response.off('close', cancel)
        }
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/action') {
        if (request.headers.origin !== origin || !String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          json(response, 403, { status: 'error', error: { code: 'MANAGER_ORIGIN_REJECTED', message: 'The Manager action did not come from this local app.' } })
          return
        }
        const result = await action(await bodyJson(request), stateRoot)
        // The lifecycle result is authoritative once the action has committed.
        // A later read failure must not invite the caller to repeat that action.
        let current = null
        let refreshError = null
        try {
          current = await dashboard(stateRoot)
        } catch (error) {
          refreshError = asPublicError(error)
        }
        json(response, 200, { status: 'ok', result, dashboard: current, refreshError })
        return
      }
      json(response, 404, { status: 'error', error: { code: 'MANAGER_ROUTE_NOT_FOUND', message: 'The requested Manager route does not exist.' } })
    } catch (error) {
      if (!response.writableEnded && !response.destroyed) {
        json(response, 400, { status: 'error', error: asPublicError(error) })
      }
    }
  })
  server.on('error', (error) => {
    if (error.code !== 'ERR_SERVER_NOT_RUNNING') process.stderr.write(`MANAGER_SERVER_FAILED: ${error.message}\n`)
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolvePromise()
    })
  })
  const address = server.address()
  origin = `http://127.0.0.1:${address.port}`
  const url = `${origin}/auth/${token}`
  touch(server)
  if (options.open !== false) openBrowser(url)
  if (options.onReady !== undefined) options.onReady({ origin, url, server })
  return await new Promise((resolvePromise) => server.once('close', () => resolvePromise({ status: 'closed' })))
}
