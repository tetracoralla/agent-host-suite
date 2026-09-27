import { assert } from '../value.mjs'
import { validateMethod } from '../method.mjs'

export const developmentMethod = {
  schema: 'openadam.method-graph.v2',
  profile: 'development',
  id: 'development',
  revision: 2,
  name: '开发与独立复核',
  description: '以 Git 候选为工作对象，依次规划、施工、独立复核、修复和最终复核。',
  roles: [
    {
      id: 'owner',
      name: '规划与最终复核',
      includeReports: true,
      defaultBinding: { provider: 'codex' },
    },
    { id: 'builder', name: '施工', defaultBinding: { provider: 'grok' } },
    {
      id: 'reviewer',
      name: '独立审查',
      independentFrom: ['builder'],
      defaultBinding: { provider: 'zcode' },
    },
  ],
  inputs: [{ id: 'goal', name: '开发目标', type: 'text', required: true }],
  artifacts: [
    { id: 'plan', name: '施工方案', type: 'text', required: true },
    {
      id: 'candidate',
      name: 'Git 候选',
      type: 'git-candidate',
      required: true,
    },
  ],
  permissions: [
    { id: 'model.invoke', name: '调用所选 Agent' },
    { id: 'workspace.write', name: '修改 Git 工作区' },
    { id: 'git.stage', name: '暂存已复核候选' },
  ],
  resources: [
    { id: 'workspace', name: 'Git 工作区', type: 'workspace', required: true, adapter: 'git' },
  ],
  graph: {
    entry: 'plan',
    extensions: {
      parallel: { version: 1, supported: false },
      wait: { version: 1, supported: false },
    },
    nodes: [
    {
      id: 'plan',
      name: '规划',
      kind: 'agent-turn',
      role: 'owner',
      instruction: '形成可执行方案和验收条件。已有目标明确时不要重新向用户确认。',
      access: 'read',
      consumes: ['goal'],
      produces: ['plan'],
      permissions: ['model.invoke'],
      resources: ['workspace'],
      transitions: [complete('build', '进入施工')],
    },
    {
      id: 'build',
      name: '施工',
      kind: 'agent-turn',
      role: 'builder',
      instruction: '完成方案中的实施并实际验证。保留原有工作。',
      access: 'write',
      consumes: ['goal', 'plan'],
      produces: ['candidate'],
      permissions: ['model.invoke', 'workspace.write'],
      resources: ['workspace'],
      transitions: [complete('review', '交给独立审查')],
    },
    {
      id: 'review',
      name: '独立审查',
      kind: 'agent-turn',
      role: 'reviewer',
      instruction: '独立检查目标、当前候选与真实流程。不要只复述施工者。发现缺陷则返回 changes_requested。',
      access: 'read',
      consumes: ['goal', 'plan', 'candidate'],
      produces: [],
      permissions: ['model.invoke'],
      resources: ['workspace'],
      transitions: [changes('fix'), complete('final-review', '进入最终复核')],
    },
    {
      id: 'fix',
      name: '修复',
      kind: 'agent-turn',
      role: 'builder',
      instruction: '修复仍有效的发现，重新验证受影响行为。',
      access: 'write',
      consumes: ['goal', 'plan', 'candidate'],
      produces: ['candidate'],
      permissions: ['model.invoke', 'workspace.write'],
      resources: ['workspace'],
      transitions: [complete('review', '重新审查')],
    },
    {
      id: 'final-review',
      name: '最终复核',
      kind: 'agent-turn',
      role: 'owner',
      instruction: '在原会话复核最新候选、独立发现与修复证据。未满足目标则要求返工。',
      access: 'read',
      consumes: ['goal', 'plan', 'candidate'],
      produces: [],
      permissions: ['model.invoke'],
      resources: ['workspace'],
      transitions: [changes('fix'), complete(null, '完成')],
    },
    ],
  },
}

function complete(to, label) {
  return {
    when: { path: 'outcome', operator: 'equals', value: 'complete' },
    to,
    label,
  }
}

function changes(to) {
  return {
    when: {
      path: 'outcome',
      operator: 'equals',
      value: 'changes_requested',
    },
    to,
    label: '需要修改',
  }
}

export function validateDevelopmentMethod(value) {
  const method = validateMethod(value)
  assert(method.profile === 'development', 'INVALID_METHOD', 'Development profile is required')
  assert(method.resources.some((resource) => resource.id === 'workspace' && resource.type === 'workspace' && resource.adapter === 'git'), 'INVALID_METHOD', 'Development profile requires the Git workspace resource')
  for (const id of ['owner', 'builder', 'reviewer'])
    assert(method.roles.some((role) => role.id === id), 'INVALID_METHOD', `Development profile requires ${id}`)
  const nodes = method.graph.nodes
  const terminals = nodes.filter((stage) =>
    stage.transitions.some((route) => route.to === null),
  )
  assert(
    nodes.find((node) => node.id === method.graph.entry)?.role === 'owner' && nodes.find((node) => node.id === method.graph.entry)?.access === 'read',
    'INVALID_METHOD',
    'Development planning starts with a read-only owner',
  )
  assert(
    terminals.every((stage) => stage.role === 'owner' && stage.access === 'read'),
    'INVALID_METHOD',
    'Development completion requires read-only owner verification',
  )
  assert(
    nodes.some((stage) => stage.role === 'reviewer' && stage.access === 'read'),
    'INVALID_METHOD',
    'Development profile requires independent read-only review',
  )
  const visit = (stage, reviewed, seen) => {
    const key = `${stage.id}:${reviewed}`
    if (seen.has(key)) return
    seen.add(key)
    const valid = stage.access === 'write' ? false : reviewed || stage.role === 'reviewer'
    for (const route of stage.transitions) {
      if (route.to === null)
        assert(valid, 'INVALID_METHOD', 'A development writer cannot bypass independent review')
      else
        visit(
          nodes.find((item) => item.id === route.to),
          valid,
          seen,
        )
    }
  }
  visit(nodes.find((node) => node.id === method.graph.entry), false, new Set())
  return method
}
