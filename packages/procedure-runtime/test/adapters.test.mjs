import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  AgentAdapter,
  nativeReply,
  nativeQuestions,
  providerCommand,
} from '../src/adapters.mjs'
import { Rpc } from '../src/rpc.mjs'

test('native permission and question replies preserve each protocol, exact options and turn scope', () => {
  const nativeOptions = {
    method: 'item/commandExecution/requestApproval',
    params: { availableDecisions: ['accept', 'cancel'] },
  }
  assert.deepEqual(nativeReply('codex', nativeOptions, false), {
    decision: 'cancel',
  })
  assert.throws(
    () =>
      nativeReply(
        'codex',
        {
          ...nativeOptions,
          params: { availableDecisions: ['acceptForSession', 'cancel'] },
        },
        true,
      ),
    { code: 'PERMISSION_UNSUPPORTED' },
  )
  const grant = {
    method: 'item/permissions/requestApproval',
    params: { permissions: { network: { enabled: true } } },
  }
  assert.deepEqual(nativeReply('codex', grant, true), {
    permissions: grant.params.permissions,
    scope: 'turn',
  })
  assert.deepEqual(nativeReply('codex', grant, false), {
    permissions: {},
    scope: 'turn',
  })
  const codex = {
    method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'choice', question: 'Which?', options: [] }] },
  }
  assert.deepEqual(
    nativeReply('codex', codex, true, { choice: ['Keep local'] }),
    { answers: { choice: { answers: ['Keep local'] } } },
  )
  assert.throws(() => nativeReply('codex', codex, true, {}), {
    code: 'ANSWER_REQUIRED',
  })
  const zcode = {
    method: 'interaction/requestUserInput',
    params: {
      questions: [
        {
          question: 'Which?',
          options: [{ label: 'Local', value: 'Local' }],
          multiSelect: false,
        },
      ],
    },
  }
  assert.equal(nativeQuestions('zcode', zcode)[0].id, 'answer_0')
  assert.deepEqual(nativeReply('zcode', zcode, true, { answer_0: ['Local'] }), {
    action: 'accept',
    content: { answer_0: 'Local' },
  })
  assert.deepEqual(
    nativeReply('zcode', { method: 'interaction/requestPermission' }, true),
    { decision: 'allow' },
  )
  const grok = {
    method: 'session/request_permission',
    params: {
      options: [
        { optionId: 'native-once', kind: 'allow_once' },
        { optionId: 'permanent', kind: 'allow_always' },
      ],
    },
  }
  assert.deepEqual(nativeReply('grok', grok, true), {
    outcome: { outcome: 'selected', optionId: 'native-once' },
  })
  assert.deepEqual(nativeReply('grok', grok, false), {
    outcome: { outcome: 'cancelled' },
  })
  assert(providerCommand('codex').args.includes('multi_agent'))
})

test('Codex buffers pre-ACK events, rejects another turn, and does not equate sent input with acceptance', async () => {
  const rpc = new EventEmitter()
  rpc.notify = () => {}
  rpc.close = async () => {}
  let ack
  rpc.request = (method) => {
    if (method === 'thread/start')
      return Promise.resolve({
        thread: { id: 'original', turns: [] },
        model: 'selected',
      })
    if (method === 'turn/start')
      return new Promise((r) => {
        ack = r
      })
    throw new Error(method)
  }
  const events = []
  const adapter = new AgentAdapter(
    { provider: 'codex' },
    { enclose: false, rpcFactory: () => rpc, onEvent: (e) => events.push(e) },
  )
  await adapter.session()
  const accepted = []
  const done = adapter.start('task', {
    timeoutMs: 1000,
    onAccepted: (e) => accepted.push(e),
  })
  rpc.emit('event', {
    method: 'turn/completed',
    params: { threadId: 'original', turn: { id: 'old', status: 'completed' } },
  })
  assert.equal(accepted.length, 0)
  ack({ turn: { id: 'current' } })
  await new Promise((r) => setImmediate(r))
  assert.equal(accepted.length, 1)
  rpc.emit('event', {
    method: 'item/completed',
    params: {
      threadId: 'original',
      turnId: 'current',
      item: { type: 'agentMessage', text: 'current answer' },
    },
  })
  rpc.emit('event', {
    method: 'turn/completed',
    params: {
      threadId: 'original',
      turn: { id: 'current', status: 'completed' },
    },
  })
  const result = await done
  assert.equal(result.text, 'current answer')
  assert.equal(result.turnId, 'current')
  assert(events.some((e) => e.kind === 'late-turn-event'))
  await adapter.close()
})

test('loading an active native owner does not start another turn', async () => {
  const rpc = new EventEmitter()
  rpc.request = async () => ({
    thread: {
      id: 'busy',
      turns: [{ id: 'existing-turn', status: 'inProgress' }],
    },
  })
  const adapter = new AgentAdapter(
    { provider: 'codex' },
    { enclose: false, rpcFactory: () => rpc },
  )
  await assert.rejects(adapter.session('busy'), { code: 'SESSION_BUSY' })
})

test('real JSONL child transport preserves Unicode, callback IDs and protocol errors', async (t) => {
  const script = `import {createInterface} from 'node:readline';
    const lines=createInterface({input:process.stdin});
    lines.on('line', line=>{const m=JSON.parse(line); if(m.method==='echo'){
      const b=Buffer.from(JSON.stringify({id:m.id,result:{text:m.params.text}})+'\\n');
      process.stdout.write(b.subarray(0,b.length-4)); setImmediate(()=>process.stdout.write(b.subarray(b.length-4)));
    }else if(m.method==='ask'){process.stdout.write(JSON.stringify({id:'native-request',method:'permission',params:{}})+'\\n');process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');}
    else if(m.id==='native-request'){process.stdout.write(JSON.stringify({method:'received',params:m.result})+'\\n');}
    else process.stdout.write(JSON.stringify({id:m.id,error:{code:77,message:'native rejection'}})+'\\n');});`
  const rpc = new Rpc(process.execPath, ['--input-type=module', '-e', script], {
    deadlineMs: 1000,
  })
  const failures = []
  rpc.on('failure', (e) => failures.push(e))
  t.after(() => rpc.close())
  assert.deepEqual(await rpc.request('echo', { text: '保持原会话 🧭' }), {
    text: '保持原会话 🧭',
  })
  const callback = new Promise((r) => rpc.once('request', r))
  await rpc.request('ask')
  assert.equal((await callback).id, 'native-request')
  const response = new Promise((r) => rpc.once('event', r))
  rpc.reply('native-request', { allow: false })
  assert.deepEqual((await response).params, { allow: false })
  await assert.rejects(
    rpc.request('fail'),
    (e) => e.code === 'PROVIDER_ERROR' && e.details.native.code === 77,
  )
})

test('Codex rejects a foreign permission and retires requests resolved natively', () => {
  const rpc = new EventEmitter()
  const rejected = [],
    permissions = [],
    events = []
  rpc.reject = (id) => rejected.push(id)
  const a = new AgentAdapter(
    { provider: 'codex' },
    {
      enclose: false,
      rpcFactory: () => rpc,
      onPermission: (p) => permissions.push(p),
      onEvent: (e) => events.push(e),
    },
  )
  a.sessionId = 'owned'
  a.turnId = 'current'
  const request = {
    id: 1,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'other', turnId: 'current' },
  }
  rpc.emit('request', request)
  assert.deepEqual(rejected, [1])
  assert.equal(permissions.length, 0)
  rpc.emit('request', {
    ...request,
    id: 2,
    params: { threadId: 'owned', turnId: 'current' },
  })
  rpc.emit('event', {
    method: 'serverRequest/resolved',
    params: { threadId: 'owned', requestId: 2 },
  })
  assert.equal(a.requests.size, 0)
  assert(
    events.some((e) => e.kind === 'permission-resolved' && e.requestId === 2),
  )
})

test('ZCode uses correlated native payloads and does not certify a cancelled turn or an old answer', async () => {
  for (const resultType of ['success', 'cancelled', 'error_max_turns']) {
    const rpc = new EventEmitter()
    rpc.request = async (method) => {
      assert.equal(method, 'session/send')
      return { accepted: true, stateRevision: 2 }
    }
    const a = new AgentAdapter(
      { provider: 'zcode' },
      { enclose: false, rpcFactory: () => rpc },
    )
    a.sessionId = 'owned'
    a.nativeRevision = 1
    const done = a.start('task', {
      requestId: 'input-current',
      timeoutMs: 1000,
    })
    await new Promise((resolve) => setImmediate(resolve))
    const emit = (type, turnId, payload) =>
      rpc.emit('event', {
        method: 'session/event',
        params: { event: { sessionId: 'owned', turnId, type, payload } },
      })
    emit('turn.completed', 'old', {
      inputId: 'old-input',
      response: 'old answer',
      resultType: 'success',
    })
    emit('turn.started', 'native-current', { inputId: 'input-current' })
    emit('part.delta', 'native-current', {
      field: 'reasoning',
      delta: 'not user text',
    })
    emit('turn.completed', 'native-current', {
      inputId: 'input-current',
      response: 'current answer',
      resultType,
    })
    const result = await done
    assert.equal(
      result.status,
      resultType === 'success'
        ? 'complete'
        : resultType === 'cancelled'
          ? 'interrupted'
          : 'failed',
    )
    assert.equal(result.text, 'current answer')
    assert.equal(result.turnId, 'native-current')
  }
})

test('Grok native message boundaries separate commentary from the final structured report', async () => {
  const rpc = new EventEmitter()
  let resolve
  rpc.request = () =>
    new Promise((r) => {
      resolve = r
    })
  const adapter = new AgentAdapter(
    { provider: 'grok' },
    { enclose: false, rpcFactory: () => rpc },
  )
  adapter.sessionId = 'fixture-session'
  const done = adapter.start('test', { timeoutMs: 1000 })
  for (const [stream, text] of [
    [1, 'Working now'],
    [2, '{"outcome":'],
    [2, '"complete"}'],
  ])
    rpc.emit('event', {
      method: 'session/update',
      params: {
        sessionId: 'fixture-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
        _meta: { streamStartMs: stream },
      },
    })
  resolve({ stopReason: 'end_turn', _meta: { usage: { modelCalls: 2 } } })
  const result = await done
  assert.equal(result.text, '{"outcome":"complete"}')
  assert.deepEqual(result.usage, { modelCalls: 2 })
})
