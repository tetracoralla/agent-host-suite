import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  SCENARIO_SCHEMA,
  documentDigest,
  errorValue,
  relativeProjectPath,
  resolveContained,
  studioError,
  validateProjectConfig,
  validateScenario,
  validateStudioDocument,
} from './validation.mjs'
import { applyProposalChanges, semanticDiff } from './proposals.mjs'
import { ensureTransitionIds, initialMethodPositions } from './graph-view.mjs'

async function jsonFile(path, label) {
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    throw studioError('STUDIO_SOURCE_UNAVAILABLE', `${label} is unavailable`, { path, cause: error.code })
  }
  try {
    return JSON.parse(source)
  } catch (error) {
    throw studioError('STUDIO_SOURCE_INVALID', `${label} is not valid JSON`, { path, cause: error.message })
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function fileFingerprint(path) {
  const value = await readFile(path)
  return createHash('sha256').update(value).digest('hex')
}

function sourcePathMap(root, config, integration) {
  return {
    project: join(root, 'studio.project.json'),
    integration: config.paths.integration,
    method: resolveContained(root, integration.execution.method, 'Procedure method path'),
    inputSchema: resolveContained(root, integration.procedure.inputSchema, 'Procedure input schema path'),
    outputSchema: resolveContained(root, integration.procedure.outputSchema, 'Procedure output schema path'),
  }
}

async function sourceFingerprint(paths) {
  const entries = await Promise.all(
    Object.entries(paths).map(async ([key, path]) => [key, await fileFingerprint(path)]),
  )
  return Object.fromEntries(entries)
}

function sameFingerprints(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function defaultPresentation(method) {
  return {
    positions: initialMethodPositions(method),
    viewport: { x: 0, y: 0, zoom: 1 },
    selection: [],
    leftPanel: 248,
    rightPanel: 382,
    runPanel: 290,
    runPanelOpen: false,
    activeMode: 'graph',
    inspectorTab: 'settings',
    runTab: 'timeline',
  }
}

function scenarioSlug(name) {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60)
  return /^[a-z]/u.test(slug) ? slug : `scenario-${slug || 'run'}`
}

export class StudioProject {
  static async open(projectPath, stateRoot) {
    const projectRoot = await realpath(resolve(projectPath)).catch(() => null)
    if (projectRoot === null || !(await stat(projectRoot)).isDirectory()) {
      throw studioError('STUDIO_PROJECT_UNAVAILABLE', 'Procedure Studio project directory is unavailable', { path: resolve(projectPath) })
    }
    const rawConfig = await jsonFile(join(projectRoot, 'studio.project.json'), 'Studio project')
    const config = validateProjectConfig(rawConfig, projectRoot)
    const integration = await jsonFile(config.paths.integration, 'Procedure integration')
    const paths = sourcePathMap(projectRoot, config, integration)
    const sourceDocument = {
      integration,
      method: await jsonFile(paths.method, 'Method source'),
      inputSchema: await jsonFile(paths.inputSchema, 'Procedure input schema'),
      outputSchema: await jsonFile(paths.outputSchema, 'Procedure output schema'),
    }
    const document = { ...sourceDocument, method: ensureTransitionIds(sourceDocument.method) }
    const validation = validateStudioDocument(document)
    const fingerprints = await sourceFingerprint(paths)
    const key = createHash('sha256').update(projectRoot).digest('hex')
    const privateRoot = resolve(stateRoot, key)
    const sessionPath = join(privateRoot, 'session.json')
    const scenarios = []
    for (const path of config.paths.scenarios) scenarios.push(validateScenario(await jsonFile(path, `Test scenario ${basename(path)}`)))
    let session = null
    try {
      session = JSON.parse(await readFile(sessionPath, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw studioError('STUDIO_SESSION_INVALID', 'Private Studio session cannot be read', { cause: error.message })
    }
    const recovered = session?.draft && session?.presentation
    const selectedDocument = recovered
      ? { ...session.draft, method: ensureTransitionIds(session.draft.method) }
      : document
    const selectedValidation = recovered ? validateStudioDocument(selectedDocument) : validation
    const sourceConflict = recovered && !sameFingerprints(session.sourceFingerprints, fingerprints)
    return new StudioProject({
      root: projectRoot,
      stateRoot: privateRoot,
      sessionPath,
      config,
      paths,
      document: selectedDocument,
      validation: selectedValidation,
      presentation: recovered ? session.presentation : defaultPresentation(document.method),
      scenarios,
      revision: Number.isSafeInteger(session?.revision) ? session.revision : 0,
      sourceFingerprints: recovered ? session.sourceFingerprints : fingerprints,
      currentSourceFingerprints: fingerprints,
      savedDocumentDigest: documentDigest(sourceDocument),
      sourceConflict,
      lastSavedAt: session?.lastSavedAt ?? null,
      proposal: session?.proposal ?? null,
      proposalDecisions: session?.proposalDecisions ?? {},
    })
  }

  constructor(value) {
    Object.assign(this, value)
  }

  publicState() {
    return {
      schemaVersion: 'openadam.procedure-studio-state.v0.1',
      project: {
        root: this.root,
        componentId: this.config.componentId,
        author: this.config.author,
        licenseSpdx: this.config.licenseSpdx,
        output: this.config.output,
      },
      revision: this.revision,
      document: structuredClone(this.document),
      documentDigest: documentDigest(this.document),
      validation: structuredClone(this.validation),
      presentation: structuredClone(this.presentation),
      scenarios: structuredClone(this.scenarios),
      source: {
        conflict: this.sourceConflict,
        saved: !this.sourceConflict && documentDigest(this.document) === this.savedDocumentDigest,
        lastSavedAt: this.lastSavedAt,
        paths: Object.fromEntries(Object.entries(this.paths).map(([key, path]) => [key, path])),
      },
      proposal: this.proposal === null ? null : structuredClone(this.proposal),
      proposalDecisions: structuredClone(this.proposalDecisions),
    }
  }

  async persist() {
    await atomicJson(this.sessionPath, {
      schemaVersion: 'openadam.procedure-studio-session.v0.1',
      revision: this.revision,
      draft: this.document,
      presentation: this.presentation,
      sourceFingerprints: this.sourceFingerprints,
      savedDocumentDigest: this.savedDocumentDigest,
      lastSavedAt: this.lastSavedAt,
      proposal: this.proposal,
      proposalDecisions: this.proposalDecisions,
    })
  }

  assertRevision(expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.revision) {
      throw studioError('STUDIO_REVISION_CONFLICT', 'Studio draft changed; reload the latest revision before applying this edit', { expectedRevision, actualRevision: this.revision })
    }
  }

  async update({ expectedRevision, document, presentation }) {
    this.assertRevision(expectedRevision)
    if (document !== undefined) {
      this.document = { ...structuredClone(document), method: ensureTransitionIds(document.method) }
      this.validation = validateStudioDocument(this.document)
    }
    if (presentation !== undefined) {
      if (presentation === null || typeof presentation !== 'object' || Array.isArray(presentation)) {
        throw studioError('STUDIO_PRESENTATION_INVALID', 'Studio presentation state must be an object')
      }
      this.presentation = structuredClone(presentation)
    }
    this.revision += 1
    await this.persist()
    return this.publicState()
  }

  async save(expectedRevision) {
    this.assertRevision(expectedRevision)
    if (this.sourceConflict) {
      throw studioError('STUDIO_SOURCE_CONFLICT', 'Source files changed outside Studio; reload or reconcile before saving', { paths: this.paths })
    }
    if (!this.validation.valid) {
      throw studioError('STUDIO_VALIDATION_FAILED', 'Fix source validation errors before saving', { diagnostics: this.validation.diagnostics })
    }
    const live = await sourceFingerprint(this.paths)
    if (!sameFingerprints(live, this.currentSourceFingerprints)) {
      this.sourceConflict = true
      throw studioError('STUDIO_SOURCE_CONFLICT', 'Source files changed outside Studio; reload or reconcile before saving', { paths: this.paths })
    }
    await atomicJson(this.paths.integration, this.document.integration)
    await atomicJson(this.paths.method, this.document.method)
    await atomicJson(this.paths.inputSchema, this.document.inputSchema)
    await atomicJson(this.paths.outputSchema, this.document.outputSchema)
    const fingerprints = await sourceFingerprint(this.paths)
    this.currentSourceFingerprints = fingerprints
    this.sourceFingerprints = fingerprints
    this.sourceConflict = false
    this.savedDocumentDigest = documentDigest(this.document)
    this.lastSavedAt = new Date().toISOString()
    this.revision += 1
    await this.persist()
    return this.publicState()
  }

  async reload(expectedRevision) {
    this.assertRevision(expectedRevision)
    const config = validateProjectConfig(await jsonFile(join(this.root, 'studio.project.json'), 'Studio project'), this.root)
    const integration = await jsonFile(config.paths.integration, 'Procedure integration')
    this.config = config
    this.paths = sourcePathMap(this.root, config, integration)
    const sourceDocument = {
      integration,
      method: await jsonFile(this.paths.method, 'Method source'),
      inputSchema: await jsonFile(this.paths.inputSchema, 'Procedure input schema'),
      outputSchema: await jsonFile(this.paths.outputSchema, 'Procedure output schema'),
    }
    this.document = { ...sourceDocument, method: ensureTransitionIds(sourceDocument.method) }
    this.scenarios = []
    for (const path of config.paths.scenarios) this.scenarios.push(validateScenario(await jsonFile(path, `Test scenario ${basename(path)}`)))
    this.validation = validateStudioDocument(this.document)
    this.presentation = defaultPresentation(this.document.method)
    this.currentSourceFingerprints = await sourceFingerprint(this.paths)
    this.sourceFingerprints = this.currentSourceFingerprints
    this.sourceConflict = false
    this.savedDocumentDigest = documentDigest(sourceDocument)
    this.proposal = null
    this.proposalDecisions = {}
    this.revision += 1
    await this.persist()
    return this.publicState()
  }

  async reconcile(expectedRevision) {
    this.assertRevision(expectedRevision)
    if (!this.sourceConflict) {
      throw studioError('STUDIO_SOURCE_CURRENT', 'Source files have not changed outside Studio')
    }
    const recoveredDraft = structuredClone(this.document)
    const config = validateProjectConfig(await jsonFile(join(this.root, 'studio.project.json'), 'Studio project'), this.root)
    const integration = await jsonFile(config.paths.integration, 'Procedure integration')
    this.config = config
    this.paths = sourcePathMap(this.root, config, integration)
    const sourceDocument = {
      integration,
      method: await jsonFile(this.paths.method, 'Method source'),
      inputSchema: await jsonFile(this.paths.inputSchema, 'Procedure input schema'),
      outputSchema: await jsonFile(this.paths.outputSchema, 'Procedure output schema'),
    }
    const document = { ...sourceDocument, method: ensureTransitionIds(sourceDocument.method) }
    this.scenarios = []
    for (const path of config.paths.scenarios) this.scenarios.push(validateScenario(await jsonFile(path, `Test scenario ${basename(path)}`)))
    const nextPresentation = defaultPresentation(document.method)
    const nodeIds = new Set(document.method.graph.nodes.map((node) => node.id))
    for (const id of nodeIds) {
      if (this.presentation.positions?.[id]) nextPresentation.positions[id] = structuredClone(this.presentation.positions[id])
    }
    Object.assign(nextPresentation, {
      viewport: structuredClone(this.presentation.viewport ?? nextPresentation.viewport),
      selection: [],
      runPanelOpen: Boolean(this.presentation.runPanelOpen),
      activeMode: this.presentation.activeMode ?? nextPresentation.activeMode,
      inspectorTab: 'changes',
      runTab: this.presentation.runTab ?? nextPresentation.runTab,
    })
    this.document = document
    this.validation = validateStudioDocument(document)
    this.presentation = nextPresentation
    this.currentSourceFingerprints = await sourceFingerprint(this.paths)
    this.sourceFingerprints = this.currentSourceFingerprints
    this.sourceConflict = false
    this.savedDocumentDigest = documentDigest(sourceDocument)
    this.proposal = semanticDiff(document, recoveredDraft)
    this.proposal.source = 'recovered-draft'
    this.proposalDecisions = {}
    this.revision += 1
    await this.persist()
    return this.publicState()
  }

  async loadProposal(expectedRevision, candidate) {
    this.assertRevision(expectedRevision)
    const normalizedCandidate = { ...structuredClone(candidate), method: ensureTransitionIds(candidate.method) }
    this.proposal = semanticDiff(this.document, normalizedCandidate)
    this.proposalDecisions = {}
    this.revision += 1
    await this.persist()
    return this.publicState()
  }

  async decideProposal(expectedRevision, { accept = [], reject = [] }) {
    this.assertRevision(expectedRevision)
    if (!this.proposal) throw studioError('STUDIO_PROPOSAL_UNAVAILABLE', 'No Agent proposal is loaded')
    const known = new Set(this.proposal.changes.map((item) => item.id))
    for (const id of [...accept, ...reject]) {
      if (!known.has(id)) throw studioError('STUDIO_PROPOSAL_STALE', `Proposal change is no longer current: ${id}`)
    }
    if (accept.some((id) => reject.includes(id))) {
      throw studioError('STUDIO_PROPOSAL_INVALID', 'A proposal change cannot be accepted and rejected together')
    }
    if (accept.length > 0) {
      const applied = applyProposalChanges(this.document, this.proposal, accept)
      this.document = { ...applied, method: ensureTransitionIds(applied.method) }
      this.validation = validateStudioDocument(this.document)
    }
    for (const id of accept) this.proposalDecisions[id] = 'accepted'
    for (const id of reject) this.proposalDecisions[id] = 'rejected'
    this.revision += 1
    await this.persist()
    return this.publicState()
  }

  async saveScenario(expectedRevision, candidate) {
    this.assertRevision(expectedRevision)
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw studioError('STUDIO_SCENARIO_INVALID', 'Scenario candidate must be an object')
    }
    if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) {
      throw studioError('STUDIO_SCENARIO_INVALID', 'Scenario name is required')
    }
    const id = scenarioSlug(candidate.name.trim())
    if (this.scenarios.some((item) => item.id === id)) {
      throw studioError('STUDIO_SCENARIO_EXISTS', `A Test scenario named “${id}” already exists`, { id })
    }
    const live = await sourceFingerprint(this.paths)
    if (!sameFingerprints(live, this.currentSourceFingerprints)) {
      this.sourceConflict = true
      throw studioError('STUDIO_SOURCE_CONFLICT', 'Project source changed outside Studio; reload or reconcile before adding a Test scenario', { paths: this.paths })
    }
    const scenario = validateScenario({
      schemaVersion: SCENARIO_SCHEMA,
      id,
      name: candidate.name.trim(),
      ...(candidate.description === undefined ? {} : { description: candidate.description }),
      inputs: candidate.inputs ?? {},
      grants: candidate.grants ?? [],
      resources: candidate.resources ?? {},
      limits: candidate.limits ?? {},
      bindings: candidate.bindings ?? {},
    })
    const directory = this.config.paths.scenarios.length > 0 ? dirname(this.config.paths.scenarios[0]) : resolve(this.root, 'scenarios')
    const absolute = resolveContained(this.root, relativeProjectPath(this.root, join(directory, `${id}.json`)), 'Scenario path')
    await atomicJson(absolute, scenario)
    const scenarioRelative = relativeProjectPath(this.root, absolute)
    const nextScenarios = [...this.config.scenarios, scenarioRelative]
    await atomicJson(join(this.root, 'studio.project.json'), {
      schemaVersion: this.config.schemaVersion,
      componentId: this.config.componentId,
      author: this.config.author,
      licenseSpdx: this.config.licenseSpdx,
      integration: this.config.integration,
      scenarios: nextScenarios,
      output: this.config.output,
    })
    this.config = { ...this.config, scenarios: nextScenarios, paths: { ...this.config.paths, scenarios: [...this.config.paths.scenarios, absolute] } }
    this.scenarios = [...this.scenarios, scenario]
    const fingerprints = await sourceFingerprint(this.paths)
    this.currentSourceFingerprints = fingerprints
    this.sourceFingerprints = fingerprints
    this.revision += 1
    await this.persist()
    return this.publicState()
  }

  async updateScenario(expectedRevision, scenarioId, candidate) {
    this.assertRevision(expectedRevision)
    const index = this.scenarios.findIndex((item) => item.id === scenarioId)
    if (index < 0) throw studioError('STUDIO_SCENARIO_NOT_FOUND', 'Test scenario was not found', { scenarioId })
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw studioError('STUDIO_SCENARIO_INVALID', 'Scenario candidate must be an object')
    }
    if (candidate.id !== scenarioId) {
      throw studioError('STUDIO_SCENARIO_ID_IMMUTABLE', 'Rename the scenario label without changing its stable id', { scenarioId, candidateId: candidate.id })
    }
    const scenario = validateScenario(candidate)
    const path = this.config.paths.scenarios[index]
    const disk = validateScenario(await jsonFile(path, `Test scenario ${basename(path)}`))
    if (JSON.stringify(disk) !== JSON.stringify(this.scenarios[index])) {
      throw studioError('STUDIO_SCENARIO_CONFLICT', 'The Test scenario changed outside Studio; reload before overwriting it', { scenarioId, path })
    }
    await atomicJson(path, scenario)
    this.scenarios = this.scenarios.map((item, itemIndex) => itemIndex === index ? scenario : item)
    this.revision += 1
    await this.persist()
    return this.publicState()
  }

  async reloadScenarios(expectedRevision) {
    this.assertRevision(expectedRevision)
    const config = validateProjectConfig(await jsonFile(join(this.root, 'studio.project.json'), 'Studio project'), this.root)
    const fields = ['schemaVersion', 'componentId', 'author', 'licenseSpdx', 'integration', 'scenarios', 'output']
    const declared = Object.fromEntries(fields.map((key) => [key, config[key]]))
    const current = Object.fromEntries(fields.map((key) => [key, this.config[key]]))
    if (JSON.stringify(declared) !== JSON.stringify(current)) {
      this.sourceConflict = true
      throw studioError('STUDIO_SOURCE_CONFLICT', 'The Studio project manifest changed outside Studio; reload the complete project before continuing', { path: join(this.root, 'studio.project.json') })
    }
    const scenarios = []
    for (const path of config.paths.scenarios) scenarios.push(validateScenario(await jsonFile(path, `Test scenario ${basename(path)}`)))
    this.scenarios = scenarios
    this.revision += 1
    await this.persist()
    return this.publicState()
  }
}

export function publicProjectError(error) {
  return { error: errorValue(error) }
}
