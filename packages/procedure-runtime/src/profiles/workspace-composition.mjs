export const workspaceCompositionMethod = {
  schema: 'openadam.method-graph.v2',
  profile: null,
  id: 'workspace-composition',
  revision: 1,
  name: 'Workspace composition',
  description: 'Prepare workspace-backed input, normalize it through a Direct Capability, and pass it to one exact subprocedure.',
  roles: [
    {
      id: 'builder',
      name: 'Workspace builder',
      defaultBinding: { provider: 'codex' },
    },
  ],
  inputs: [
    { id: 'request', name: 'Requested result', type: 'text', required: true },
  ],
  artifacts: [
    { id: 'draft', name: 'Workspace-backed draft', type: 'json', required: false },
    { id: 'normalized', name: 'Normalized direct result', type: 'json', required: false },
    { id: 'final', name: 'Composed result', type: 'text', required: true },
  ],
  permissions: [
    { id: 'model.invoke', name: 'Invoke the selected Agent' },
    { id: 'workspace.write', name: 'Change the bound workspace' },
    { id: 'capability.invoke', name: 'Invoke the declared Direct Capability' },
    { id: 'procedure.invoke', name: 'Invoke the declared subprocedure' },
  ],
  resources: [
    {
      id: 'workspace',
      name: 'Git workspace',
      type: 'workspace',
      required: true,
      adapter: 'git',
    },
  ],
  graph: {
    entry: 'prepare',
    extensions: {
      parallel: { version: 1, supported: false },
      wait: { version: 1, supported: false },
    },
    nodes: [
      {
        id: 'prepare',
        name: 'Prepare the workspace draft',
        kind: 'agent-turn',
        role: 'builder',
        instruction: 'Use the bound workspace to prepare the requested result and return a JSON draft artifact.',
        access: 'write',
        consumes: ['request'],
        produces: ['draft'],
        permissions: ['model.invoke', 'workspace.write'],
        resources: ['workspace'],
        transitions: [
          {
            when: { path: 'outcome', operator: 'equals', value: 'complete' },
            to: 'normalize',
            label: 'Normalize',
          },
        ],
      },
      {
        id: 'normalize',
        name: 'Normalize through Direct Runtime',
        kind: 'direct-call',
        target: {
          kind: 'capability',
          providerId: 'test.fake-capability',
          capabilityId: 'org.openadam.test.normalize',
          capabilityVersion: '1.0.0',
          operationId: 'normalize',
        },
        input: {
          object: {
            draft: { path: 'outputs.draft' },
          },
        },
        output: {
          normalized: { path: 'result.outputs.normalized' },
        },
        consumes: ['draft'],
        produces: ['normalized'],
        permissions: ['capability.invoke'],
        resources: [],
        transitions: [
          {
            when: { path: 'outcome', operator: 'equals', value: 'complete' },
            to: 'delegate',
            label: 'Delegate',
          },
        ],
      },
      {
        id: 'delegate',
        name: 'Invoke exact echo subprocedure',
        kind: 'procedure-call',
        procedure: {
          id: 'org.openadam.test.echo-procedure',
          version: '0.1.0',
        },
        input: {
          object: {
            value: { path: 'outputs.normalized.value' },
          },
        },
        output: {
          final: { path: 'result.outputs.value' },
        },
        consumes: ['normalized'],
        produces: ['final'],
        permissions: ['procedure.invoke'],
        grants: [],
        resources: [],
        resourceBindings: {},
        transitions: [
          {
            when: { path: 'outcome', operator: 'equals', value: 'complete' },
            to: null,
            label: 'Complete',
          },
        ],
      },
    ],
  },
}
