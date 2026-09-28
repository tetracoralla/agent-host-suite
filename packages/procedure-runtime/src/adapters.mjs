import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Rpc } from './rpc.mjs'
import { assert, ProcedureError, id, text, object } from './value.mjs'
import { workerSandbox } from './workspace.mjs'
import { reportSchema } from './method.mjs'

export function validateBinding(binding) {
  assert(
    object(binding) && ['codex', 'grok', 'zcode'].includes(binding.provider),
    'INVALID_BINDING',
    'Choose a supported Shell',
  )
  if (binding.model) {
    if (binding.provider === 'zcode') {
      assert(
        object(binding.model),
        'INVALID_BINDING',
        'ZCode model selection requires its native providerId and modelId',
      )
      text(binding.model.providerId, 'ZCode provider ID', 200)
      text(binding.model.modelId, 'ZCode model ID', 200)
      if (binding.model.options?.reasoningLevel)
        text(binding.model.options.reasoningLevel, 'Reasoning level', 80)
    } else text(binding.model, 'Model', 200)
  }
  if (binding.sessionId) text(binding.sessionId, 'Session ID', 200)
  return binding
}

export function providerCommand(provider) {
  if (provider === 'codex')
    return {
      command: 'codex',
      args: [
        '--disable',
        'multi_agent',
        '--disable',
        'multi_agent_v2',
        'app-server',
        '--stdio',
      ],
    }
  if (provider === 'grok')
    return {
      command: 'grok',
      args: [
        '--permission-mode',
        'default',
        '--no-subagents',
        'agent',
        '--no-leader',
        'stdio',
      ],
      env: { GROK_SANDBOX: 'workspace' },
    }
  if (provider === 'zcode') {
    const bundled = '/Applications/ZCode.app/Contents/Resources'
    const entry = join(bundled, 'glm/zcode.cjs')
    if (existsSync(entry))
      return {
        command: process.execPath,
        args: [entry, 'app-server'],
        env: {
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(
            bundled,
            'config/provider/zcode-builtin.json',
          ),
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(
            homedir(),
            '.zcode/v2/provider_config.json',
          ),
        },
      }
    return { command: 'zcode', args: ['app-server'] }
  }
  throw new ProcedureError(
    'UNSUPPORTED_PROVIDER',
    'Choose Codex, Grok or ZCode',
  )
}

export class AgentAdapter {
  constructor(
    binding,
    {
      workspace,
      workspaceAdapter = 'git',
      stateRoot,
      contextRoot,
      writable = false,
      protectedPaths = [],
      onEvent = () => {},
      onPermission = () => {},
      enclose = true,
      rpcFactory = (command, args, options) => new Rpc(command, args, options),
    } = {},
  ) {
    this.binding = binding
    this.provider = binding.provider
    this.workspace = workspace
    this.writable = writable
    this.onEvent = onEvent
    this.onPermission = onPermission
    this.requests = new Map()
    this.text = ''
    this.usage = null
    this.enclosed = enclose
    const spec = providerCommand(this.provider)
    // Grok applies Seatbelt at process startup and cannot nest it on macOS.
    // The outer policy preserves its workspace/temp/provider-storage boundary
    // and global hook/config protection; native tool approvals remain enabled.
    if (enclose && this.provider === 'grok') spec.env.GROK_SANDBOX = 'off'
    let { command, args } = spec
    if (enclose) {
      const [wrapper, flags] = workerSandbox(workspace, {
        writable,
        workspaceAdapter,
        stateRoot,
        contextRoot,
        protectedPaths,
        runtime: this.provider,
      })
      args = [...flags, command, ...args]
      command = wrapper
    }
    this.rpc = rpcFactory(command, args, {
      cwd: workspace,
      env: spec.env,
      jsonrpc: this.provider === 'grok',
    })
    this.rpc.on('event', (m) => this.event(m))
    this.rpc.on('late', (m) =>
      this.onEvent({ kind: 'late-response', native: m }),
    )
    this.rpc.on('request', (m) => this.permission(m))
    this.rpc.on('failure', (e) => {
      this.finish?.reject(e)
      this.onEvent({ kind: 'connection-failure', message: e.message })
    })
  }
  async initialize() {
    if (this.provider === 'codex') {
      const info = await this.rpc.request('initialize', {
        clientInfo: { name: 'agent_host_procedure', version: '0.1.0' },
        capabilities: { experimentalApi: false },
      })
      this.rpc.notify('initialized')
      return {
        provider: this.provider,
        version: info.userAgent,
        create: 'supported',
        resume: 'supported',
        steer: 'supported',
        interrupt: 'supported',
        activeTakeover: 'unsupported',
        gitWrite: this.enclosed ? 'locally-enclosed' : 'not-active',
        modelExecution: 'unverified',
        externalEffects: 'provider-permissions',
        usage: 'partial',
      }
    }
    if (this.provider === 'grok') {
      this.info = await this.rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      })
      return {
        provider: this.provider,
        version: this.info._meta?.agentVersion,
        model: this.info._meta?.modelState?.currentModelId,
        create: 'supported',
        resume: this.info.agentCapabilities?.loadSession
          ? 'supported'
          : 'unsupported',
        steer: 'unsupported',
        interrupt: 'supported',
        activeTakeover: 'unsupported',
        gitWrite: this.enclosed ? 'locally-enclosed' : 'not-active',
        modelExecution: 'unverified',
        externalEffects: 'provider-permissions',
        usage: 'unknown',
      }
    }
    const native = await this.rpc.request('runtime/capabilities')
    return {
      provider: this.provider,
      native,
      create: 'supported',
      resume: 'partial',
      steer: 'unsupported',
      interrupt: 'supported',
      activeTakeover: 'unsupported',
      gitWrite: this.enclosed ? 'locally-enclosed' : 'not-active',
      modelExecution: 'unverified',
      externalEffects: 'provider-permissions',
      usage: 'unknown',
    }
  }
  async session(existing) {
    if (this.provider === 'codex') {
      const params = {
        cwd: this.workspace,
        approvalPolicy: 'untrusted',
        sandbox: this.writable ? 'workspace-write' : 'read-only',
        ...(this.binding.model ? { model: this.binding.model } : {}),
      }
      // Never fork or silently replace a requested owner session.
      const result = await this.rpc.request(
        existing ? 'thread/resume' : 'thread/start',
        { ...params, ...(existing ? { threadId: existing } : {}) },
      )
      this.sessionId = result.thread.id
      assert(
        !existing || this.sessionId === existing,
        'SESSION_MISMATCH',
        'Provider returned a different owner session',
      )
      assert(
        result.thread.status?.type !== 'active' &&
          !result.thread.turns?.some((turn) => turn.status === 'inProgress'),
        'SESSION_BUSY',
        'The original Codex session has an active turn; stop it through its current owner before continuing',
      )
      this.model = result.model
      assert(
        !this.binding.model || this.binding.model === this.model,
        'MODEL_MISMATCH',
        'Codex selected model differs from the binding',
      )
      return { id: this.sessionId, model: this.model, provider: this.provider }
    }
    if (this.provider === 'grok') {
      assert(
        !existing || this.info?.agentCapabilities?.loadSession,
        'RESUME_UNSUPPORTED',
        'This Grok version cannot load the original session',
      )
      const auth = this.info.authMethods?.find((x) => x.id === 'cached_token')
      assert(auth, 'AUTH_REQUIRED', 'Sign in to Grok before using this binding')
      await this.rpc.request('authenticate', {
        methodId: auth.id,
        _meta: { headless: true },
      })
      const result = await this.rpc.request(
        existing ? 'session/load' : 'session/new',
        {
          cwd: this.workspace,
          mcpServers: [],
          ...(existing ? { sessionId: existing } : {}),
        },
      )
      this.sessionId = existing ?? result.sessionId
      this.model =
        result.models?.currentModelId ??
        this.info._meta?.modelState?.currentModelId
      assert(
        !this.binding.model || this.binding.model === this.model,
        'MODEL_MISMATCH',
        'Configured Grok model differs; no model was substituted',
        { selected: this.binding.model, actual: this.model },
      )
      return { id: this.sessionId, model: this.model, provider: this.provider }
    }
    const workspace = {
      workspacePath: this.workspace,
      workspaceKey: this.workspace,
    }
    const options = {
      workspace,
      dynamicWorkflowEnabled: false,
      offPeakToolEnabled: false,
    }
    const result = await this.rpc.request(
      existing ? 'session/resume' : 'session/create',
      existing
        ? { ...options, sessionId: existing }
        : {
            ...options,
            mode: 'build',
            titleGenerationEnabled: false,
            persistence: 'immediate',
            ...(this.binding.model ? { model: this.binding.model } : {}),
          },
    )
    this.sessionId = result.session.sessionId
    assert(
      !existing || this.sessionId === existing,
      'SESSION_MISMATCH',
      'Provider returned a different owner session',
    )
    this.model = result.session.model
    this.nativeRevision = result.runtime.stateRevision
    assert(
      !result.runtime.activeTurnId &&
        !['running', 'waiting'].includes(result.session.status),
      'SESSION_BUSY',
      'The original ZCode session is active in another client',
    )
    assert(
      this.model,
      'MODEL_UNAVAILABLE',
      'ZCode app-server did not expose a selected model. Open/configure this harness through its supported interface; no model was substituted.',
    )
    assert(
      !this.binding.model ||
        (this.binding.model.modelId === this.model?.modelId &&
          this.binding.model.providerId === this.model?.providerId),
      'MODEL_MISMATCH',
      'ZCode selected model differs from the binding',
    )
    await this.rpc.request('session/subscribe', {
      sessionId: this.sessionId,
      deliveryKind: 'web-remote-replayable',
      includeSnapshot: false,
    })
    return { id: this.sessionId, model: this.model, provider: this.provider }
  }
  async start(
    prompt,
    { requestId = id(), timeoutMs = 300000, onAccepted = () => {} } = {},
  ) {
    this.text = ''
    this.usage = null
    this.lastResult = null
    this.messageStream = null
    let timer
    const done = new Promise((resolve, reject) => {
      this.finish = { resolve, reject }
      timer = setTimeout(
        () =>
          reject(
            new ProcedureError(
              'TURN_LIMIT',
              'Worker turn exceeded its time limit',
            ),
          ),
        timeoutMs,
      )
    })
    // A synchronous completion or disconnect must not become an unhandled rejection.
    done.catch(() => {})
    try {
      if (this.provider === 'codex') {
        this.starting = true
        this.startEvents = []
        const r = await this.rpc.request('turn/start', {
          threadId: this.sessionId,
          input: [{ type: 'text', text: prompt }],
          outputSchema: reportSchema,
          ...(this.enclosed
            ? {
                sandboxPolicy: {
                  type: 'externalSandbox',
                  networkAccess: 'restricted',
                },
              }
            : {}),
        })
        this.turnId = r.turn.id
        this.starting = false
        onAccepted({ turnId: this.turnId, evidence: 'provider-ack' })
        for (const event of this.startEvents)
          Object.hasOwn(event, 'id')
            ? this.permission(event)
            : this.event(event)
        this.startEvents = []
      } else if (this.provider === 'grok') {
        this.turnId = requestId
        this.rpc
          .request(
            'session/prompt',
            {
              sessionId: this.sessionId,
              prompt: [{ type: 'text', text: prompt }],
            },
            timeoutMs,
          )
          .then(
            (r) => {
              this.lastResult = r
              this.usage = r._meta?.usage ?? null
              onAccepted({ turnId: this.turnId, evidence: 'provider-result' })
              this.finish?.resolve({
                status:
                  r.stopReason === 'end_turn' ? 'complete' : 'interrupted',
                text: this.text,
                native: r,
              })
            },
            (e) => this.finish?.reject(e),
          )
      } else {
        this.inputId = requestId
        this.turnId = null
        const r = await this.rpc.request('session/send', {
          sessionId: this.sessionId,
          inputId: requestId,
          queryId: requestId,
          content: prompt,
          expectedRevision: this.nativeRevision,
        })
        this.nativeRevision = r.stateRevision
        onAccepted({
          inputId: requestId,
          turnId: this.turnId,
          evidence: 'provider-ack',
        })
      }
      const result = await done
      return {
        ...result,
        sessionId: this.sessionId,
        turnId: this.turnId,
        usage: this.usage,
      }
    } finally {
      this.starting = false
      clearTimeout(timer)
      this.finish = null
    }
  }
  event(m) {
    const p = m.params ?? {}
    const eventSession = p.threadId ?? p.sessionId ?? p.event?.sessionId
    if (eventSession && this.sessionId && eventSession !== this.sessionId) {
      this.onEvent({ kind: 'foreign-event', method: m.method })
      return
    }
    if (this.provider === 'codex') {
      if (this.starting) {
        assert(
          this.startEvents.length < 2000,
          'EVENT_LIMIT',
          'Too many events before turn acknowledgement',
        )
        this.startEvents.push(m)
        return
      }
      const turn = p.turnId ?? p.turn?.id
      if (turn && this.turnId && turn !== this.turnId) {
        this.onEvent({
          kind: 'late-turn-event',
          method: m.method,
          turnId: turn,
        })
        return
      }
      if (m.method === 'serverRequest/resolved') {
        this.requests.delete(p.requestId)
        this.onEvent({ kind: 'permission-resolved', requestId: p.requestId })
      }
      if (m.method === 'item/agentMessage/delta') this.text += p.delta ?? ''
      if (m.method === 'item/completed' && p.item?.type === 'agentMessage')
        this.text = p.item.text ?? this.text
      if (m.method === 'thread/tokenUsage/updated') this.usage = p.tokenUsage
      if (m.method === 'turn/completed')
        this.finish?.resolve({
          status: p.turn.status === 'completed' ? 'complete' : p.turn.status,
          text: this.text,
          native: p.turn,
        })
    } else if (this.provider === 'grok') {
      const u = p.update
      if (
        m.method === 'session/update' &&
        u?.sessionUpdate === 'agent_message_chunk'
      ) {
        // Grok streams commentary and its final answer as separate native
        // messages within one ACP prompt. Preserve the final message, not a
        // concatenation that makes a valid structured report unparsable.
        const stream = p._meta?.streamStartMs
        if (stream !== undefined && stream !== this.messageStream) {
          this.messageStream = stream
          this.text = ''
        }
        this.text += u.content?.text ?? ''
      }
    } else {
      if (m.method === 'state.updated')
        this.nativeRevision = p.revision ?? this.nativeRevision
      const event = p.event ?? p
      const type = event.type ?? event.kind
      const payload = event.payload ?? {}
      if (
        type === 'turn.started' &&
        (payload.inputId === this.inputId || payload.queryId === this.inputId)
      )
        this.turnId = event.turnId
      const matching =
        this.inputId &&
        (payload.inputId === this.inputId ||
          (this.turnId && event.turnId === this.turnId))
      if (
        ['turn.completed', 'turn.failed', 'part.delta'].includes(type) &&
        !matching
      ) {
        this.onEvent({
          kind: 'late-turn-event',
          method: m.method,
          turnId: event.turnId,
        })
        return
      }
      if (
        type === 'part.delta' &&
        (!payload.field || payload.field === 'text') &&
        typeof payload.delta === 'string'
      )
        this.text += payload.delta
      if (type === 'turn.completed' || type === 'turn.failed') {
        this.turnId = event.turnId ?? this.turnId
        this.finish?.resolve({
          status:
            type === 'turn.failed'
              ? 'failed'
              : payload.resultType === 'success'
                ? 'complete'
                : payload.resultType === 'cancelled'
                  ? 'interrupted'
                  : 'failed',
          text: payload.response ?? this.text,
          native: {
            event: type,
            resultType: payload.resultType,
            error: payload.error,
          },
        })
      }
    }
    if (this.text.length > 256000) {
      this.finish?.reject(
        new ProcedureError('OUTPUT_LIMIT', 'Worker answer exceeds 256 KiB'),
      )
      return
    }
    this.onEvent({ kind: 'provider-event', method: m.method, native: p })
  }
  permission(message) {
    if (this.provider === 'codex' && this.starting) {
      assert(
        this.startEvents.length < 2000,
        'EVENT_LIMIT',
        'Too many pre-ACK requests',
      )
      this.startEvents.push(message)
      return
    }
    const session = message.params?.threadId ?? message.params?.sessionId
    const turn = message.params?.turnId
    if (
      (session && this.sessionId && session !== this.sessionId) ||
      (turn && this.turnId && turn !== this.turnId)
    ) {
      this.rpc.reject(
        message.id,
        'Request does not belong to the active task turn',
      )
      this.onEvent({ kind: 'foreign-permission', method: message.method })
      return
    }
    // Host/browser/credential callbacks are not generic tools. Never fabricate credentials.
    const known =
      this.provider === 'codex'
        ? [
            'item/commandExecution/requestApproval',
            'item/fileChange/requestApproval',
            'item/tool/requestUserInput',
            'item/permissions/requestApproval',
          ].includes(message.method)
        : this.provider === 'grok'
          ? message.method === 'session/request_permission'
          : [
              'interaction/requestPermission',
              'interaction/requestUserInput',
            ].includes(message.method)
    if (!known) {
      this.rpc.reject(
        message.id,
        'This Procedure client does not provide this callback',
      )
      this.onEvent({ kind: 'unsupported-callback', method: message.method })
      return
    }
    if (message.params?.questions?.some((q) => q.isSecret)) {
      this.rpc.reject(
        message.id,
        'Enter credentials in the owning Shell; this client does not store secret answers',
      )
      this.onEvent({
        kind: 'unsupported-callback',
        method: message.method,
        reason: 'secret-input',
      })
      return
    }
    this.requests.set(message.id, message)
    this.onPermission({
      id: message.id,
      method: message.method,
      native: message.params,
      provider: this.provider,
      kind: message.method.endsWith('requestUserInput')
        ? 'question'
        : 'permission',
      requiredGrant: message.method.endsWith('requestUserInput')
        ? null
        : message.method === 'item/fileChange/requestApproval'
          ? 'workspace.write'
          : 'provider.permission',
      questions: nativeQuestions(this.provider, message),
    })
  }
  respond(requestId, allow, answer) {
    const m = this.requests.get(requestId)
    assert(m, 'STALE_PERMISSION', 'Permission request is no longer active')
    const result = nativeReply(this.provider, m, allow, answer)
    this.rpc.reply(requestId, result)
    this.requests.delete(requestId)
  }
  async steer(message) {
    assert(
      this.provider === 'codex',
      'STEER_UNSUPPORTED',
      'This binding needs interruption and a continuation turn',
    )
    return this.rpc.request('turn/steer', {
      threadId: this.sessionId,
      expectedTurnId: this.turnId,
      input: [{ type: 'text', text: message }],
    })
  }
  async interrupt() {
    if (!this.sessionId) return
    if (this.provider === 'codex' && this.turnId)
      await this.rpc.request(
        'turn/interrupt',
        { threadId: this.sessionId, turnId: this.turnId },
        5000,
      )
    else if (this.provider === 'grok')
      this.rpc.notify('session/cancel', { sessionId: this.sessionId })
    else if (this.provider === 'zcode')
      await this.rpc.request(
        'session/stop',
        { sessionId: this.sessionId },
        5000,
      )
  }
  async close() {
    for (const key of this.requests.keys()) {
      try {
        this.respond(key, false)
      } catch {}
    }
    await this.rpc.close()
  }
}

export function nativeQuestions(provider, message) {
  if (!message.method.endsWith('requestUserInput')) return []
  const questions = message.params?.questions ?? []
  assert(
    Array.isArray(questions) && questions.length <= 10,
    'INVALID_QUESTION',
    'Provider question count exceeds its bound',
  )
  return questions.map((q, index) => ({
    id: provider === 'codex' ? q.id : `answer_${index}`,
    question: q.question,
    options: (q.options ?? []).map((option) => ({
      label: option.label,
      description: option.description,
      value: option.value ?? option.label,
    })),
    multiSelect: q.multiSelect === true,
  }))
}

// Native wire responses deliberately stay different. In particular a permission
// grant is not a command approval, and a user answer is neither of those.
export function nativeReply(provider, message, allow, answer) {
  if (message.method.endsWith('requestUserInput')) {
    if (!allow)
      return provider === 'codex' ? { answers: {} } : { action: 'decline' }
    const questions = nativeQuestions(provider, message)
    assert(
      questions.length > 0,
      'INVALID_QUESTION',
      'Provider did not supply an answerable question',
    )
    const values = Object.create(null)
    for (const q of questions) {
      const choices = answer?.[q.id]
      assert(
        Array.isArray(choices) &&
          choices.length > 0 &&
          choices.length <= 30 &&
          choices.every(
            (value) =>
              typeof value === 'string' && value.trim() && value.length <= 8000,
          ),
        'ANSWER_REQUIRED',
        'Answer each provider question before continuing',
      )
      values[q.id] = choices
    }
    return provider === 'codex'
      ? {
          answers: Object.fromEntries(
            Object.entries(values).map(([key, answers]) => [key, { answers }]),
          ),
        }
      : {
          action: 'accept',
          content: Object.fromEntries(
            Object.entries(values).map(([key, values]) => [
              key,
              values.join(', '),
            ]),
          ),
        }
  }
  if (provider === 'codex') {
    if (message.method === 'item/permissions/requestApproval')
      return {
        permissions: allow ? message.params.permissions : {},
        scope: 'turn',
      }
    const choices = message.params?.availableDecisions
    const decision = allow
      ? 'accept'
      : !choices || choices.includes('decline')
        ? 'decline'
        : 'cancel'
    assert(
      !choices || choices.includes(decision),
      'PERMISSION_UNSUPPORTED',
      'Provider did not offer this one-time permission decision',
    )
    return { decision }
  }
  if (provider === 'grok') {
    const option = message.params.options?.find(
      (o) => o.kind === (allow ? 'allow_once' : 'reject_once'),
    )
    assert(
      option || !allow,
      'PERMISSION_UNSUPPORTED',
      'Provider did not offer one-time approval',
    )
    return option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } }
  }
  return { decision: allow ? 'allow' : 'deny' }
}

export async function probeProviders(workspace) {
  const results = []
  for (const provider of ['codex', 'grok', 'zcode']) {
    let adapter
    const stateRoot = mkdtempSync(join(tmpdir(), 'procedure-probe-'))
    let closed = true
    try {
      // Probe the same enclosed launcher used by tasks. A bare handshake can
      // succeed while the actual worker cannot start its native sandbox.
      adapter = new AgentAdapter({ provider }, { workspace, stateRoot })
      const capabilities = await adapter.initialize()
      results.push({
        ...capabilities,
        observedAt: new Date().toISOString(),
        modelInvoked: false,
      })
    } catch (e) {
      results.push({
        provider,
        create: 'unknown',
        error: { code: e.code ?? 'UNAVAILABLE', message: e.message },
        modelInvoked: false,
      })
    } finally {
      await adapter?.close().catch((e) => {
        closed = false
        results.push({
          provider,
          cleanup: 'unconfirmed',
          message: e.message,
        })
      })
      if (closed) rmSync(stateRoot, { recursive: true, force: true })
    }
  }
  return results
}
