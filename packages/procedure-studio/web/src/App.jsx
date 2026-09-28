import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  BaseEdge,
  EdgeText,
  MarkerType,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  AlignHorizontalSpaceAround,
  AlignVerticalSpaceAround,
  Archive,
  Bot,
  Box,
  Boxes,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleDot,
  Clipboard,
  Code2,
  Copy,
  Download,
  FileJson2,
  GitBranch,
  GripVertical,
  History,
  Keyboard,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  MoveHorizontal,
  MoveVertical,
  PackageCheck,
  PanelBottomClose,
  PanelBottomOpen,
  Pause,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  UserRound,
  Waypoints,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import { api, json } from './api.js'
import { ContractEditor } from './ContractEditor.jsx'
import { ScenarioEditor, scenarioReadiness } from './ScenarioEditor.jsx'
import { DebouncedInput, Field, TagList } from './editor-controls.jsx'
import {
  KIND_LABEL,
  NODE_LIBRARY,
  UNSUPPORTED_EXTENSIONS,
  arrangeMethodPositions,
  cloneSelection,
  defaultNode,
  deleteSelection,
  findTransition,
  flowView,
  nextTransitionId,
  pasteSelection,
  proposalSummary,
} from './model.js'

const NODE_ICONS = {
  'agent-turn': Bot,
  'direct-call': Zap,
  'procedure-call': Boxes,
  'human-input': UserRound,
  condition: GitBranch,
  transform: Braces,
}

const STATUS_LABEL = {
  ready: 'Ready',
  running: 'Running',
  waiting_user: 'Waiting for input',
  paused: 'Paused',
  failed: 'Failed',
  complete: 'Complete',
  cancelled: 'Cancelled',
  reconciling: 'Recovery required',
}

function MethodNode({ data, selected }) {
  const Icon = NODE_ICONS[data.node.kind] ?? Box
  const detail = data.node.kind === 'procedure-call'
    ? `${data.node.procedure.id}@${data.node.procedure.version}`
    : data.node.kind === 'direct-call'
      ? `${data.node.target.capabilityId}@${data.node.target.capabilityVersion}`
      : data.node.kind === 'human-input'
        ? data.node.interaction
        : `${data.node.consumes.length} in · ${data.node.produces.length} out`
  return (
    <article className={`method-node ${selected ? 'selected' : ''} ${data.diagnostics.length ? 'graph-warning' : ''} ${data.runState ? `run-${data.runState}` : ''}`} aria-label={`${data.node.name}, ${KIND_LABEL[data.node.kind] ?? data.node.kind}`}>
      <Handle id="input" type="target" position={Position.Left} aria-label="Input port" />
      <header>
        <span className="node-icon"><Icon size={15} aria-hidden="true" /></span>
        <span className="node-kind">{KIND_LABEL[data.node.kind] ?? data.node.kind}</span>
        {data.entry && <span className="entry-badge">Entry</span>}
        {data.runState && data.runState !== 'pending' && <span className={`run-dot ${data.runState}`} title={`Last run: ${data.runState}`} />}
      </header>
      <strong>{data.node.name}</strong>
      {!data.compact && <p title={detail}>{detail}</p>}
      {!data.compact && (data.node.permissions.length > 0 || data.node.resources.length > 0) && (
        <footer>
          {data.node.permissions.slice(0, 2).map((value) => <span key={value}>{value}</span>)}
          {data.node.resources.slice(0, 1).map((value) => <span key={value}>#{value}</span>)}
        </footer>
      )}
      <Handle id="output" type="source" position={Position.Right} aria-label="Output port" />
    </article>
  )
}

const nodeTypes = { methodNode: MethodNode }

function CompiledRouteEdge({ id, data, markerEnd, selected }) {
  const label = data?.label
  return (
    <>
      <BaseEdge id={id} path={data.path} markerEnd={markerEnd} className={`${data.diagnostics.length ? 'graph-route-warning' : ''} ${selected ? 'selected' : ''}`} />
      {label && <EdgeText
        x={label.x}
        y={label.y}
        label={label.text}
        labelStyle={{ fill: '#4c5b70', fontSize: 10, fontWeight: 650 }}
        labelBgStyle={{ fill: 'rgba(248, 250, 252, .94)', stroke: '#cbd4e1', strokeWidth: 1 }}
        labelBgPadding={[7, 3]}
        labelBgBorderRadius={6}
      />}
    </>
  )
}

const edgeTypes = { compiledRoute: CompiledRouteEdge }

function IconButton({ label, children, ...props }) {
  return <button className="icon-button" type="button" aria-label={label} title={label} {...props}>{children}</button>
}

function AppShell() {
  const [studio, setStudio] = useState(null)
  const [runs, setRuns] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [selectedEdge, setSelectedEdge] = useState(null)
  const [selectedRunId, setSelectedRunId] = useState(null)
  const [runDetail, setRunDetail] = useState(null)
  const [leftTab, setLeftTab] = useState('library')
  const [leftOpen, setLeftOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [runExpanded, setRunExpanded] = useState(false)
  const [inspectorTab, setInspectorTab] = useState('settings')
  const [runTab, setRunTab] = useState('timeline')
  const [sourceTab, setSourceTab] = useState('method')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const [modal, setModal] = useState(null)
  const [copied, setCopied] = useState(null)
  const [undoStack, setUndoStack] = useState([])
  const [redoStack, setRedoStack] = useState([])
  const [proposalText, setProposalText] = useState('')
  const [proposalSelection, setProposalSelection] = useState(new Set())
  const [scenarioId, setScenarioId] = useState(null)
  const [scenarioDraft, setScenarioDraft] = useState(null)
  const [scenarioDirty, setScenarioDirty] = useState(false)
  const [sourceDrafts, setSourceDrafts] = useState({})
  const [zoom, setZoom] = useState(1)
  const stateRef = useRef(null)
  const mutationQueue = useRef(Promise.resolve())
  const modalReturnFocus = useRef(null)

  const applyState = useCallback((next, nextRuns) => {
    stateRef.current = next
    setStudio(next)
    if (nextRuns) setRuns(nextRuns)
  }, [])

  const showError = useCallback((error) => {
    setNotice({ kind: 'error', title: error.code ?? 'Studio error', message: error.message })
  }, [])

  const refresh = useCallback(async () => {
    const response = await api('/api/project')
    const firstOpen = stateRef.current === null
    applyState(response.state, response.runs)
    if (firstOpen) {
      setSelectedIds(response.state.presentation.selection ?? [])
      setInspectorTab(response.state.presentation.inspectorTab ?? 'settings')
      setRunTab(response.state.presentation.runTab ?? 'timeline')
    }
    setScenarioId((current) => current ?? response.state.scenarios[0]?.id ?? null)
  }, [applyState])

  useEffect(() => {
    refresh().catch(showError)
  }, [refresh, showError])

  useEffect(() => {
    const savedZoom = studio?.presentation.viewport?.zoom
    if (Number.isFinite(savedZoom)) setZoom(savedZoom)
  }, [studio?.presentation.viewport?.zoom])

  useEffect(() => {
    const scenario = studio?.scenarios.find((item) => item.id === scenarioId)
    if (!scenario || (scenarioDraft?.id === scenario.id && scenarioDirty)) return
    setScenarioDraft(structuredClone(scenario))
    setScenarioDirty(false)
  }, [scenarioDirty, scenarioDraft?.id, scenarioId, studio?.scenarios])

  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(null), 5_000)
    return () => clearTimeout(timer)
  }, [notice])

  const mutate = useCallback((change, { history = true, label = 'Edit' } = {}) => {
    mutationQueue.current = mutationQueue.current.then(async () => {
      const current = stateRef.current
      if (!current) return
      const draft = { document: structuredClone(current.document), presentation: structuredClone(current.presentation) }
      change(draft)
      if (history) {
        setUndoStack((items) => [...items.slice(-79), { document: current.document, presentation: current.presentation, label }])
        setRedoStack([])
      }
      setBusy(true)
      try {
        const response = await api('/api/project', json('PATCH', {
          expectedRevision: current.revision,
          document: draft.document,
          presentation: draft.presentation,
        }))
        applyState(response.state, response.runs)
      } catch (error) {
        showError(error)
        await refresh().catch(() => {})
      } finally {
        setBusy(false)
      }
    })
    return mutationQueue.current
  }, [applyState, refresh, showError])

  useEffect(() => {
    if (!studio || JSON.stringify(studio.presentation.selection ?? []) === JSON.stringify(selectedIds)) return undefined
    const timer = setTimeout(() => mutate((draft) => { draft.presentation.selection = selectedIds }, { history: false, label: 'Preserve selection' }), 420)
    return () => clearTimeout(timer)
  }, [mutate, selectedIds, studio])

  const restoreSnapshot = useCallback((snapshot, destinationSetter) => {
    const current = stateRef.current
    if (!current || !snapshot) return
    destinationSetter((items) => [...items.slice(-79), { document: current.document, presentation: current.presentation, label: 'Restore' }])
    mutationQueue.current = mutationQueue.current.then(async () => {
      setBusy(true)
      try {
        const response = await api('/api/project', json('PATCH', {
          expectedRevision: stateRef.current.revision,
          document: snapshot.document,
          presentation: snapshot.presentation,
        }))
        applyState(response.state, response.runs)
      } catch (error) {
        showError(error)
      } finally {
        setBusy(false)
      }
    })
  }, [applyState, showError])

  const undo = useCallback(() => {
    const snapshot = undoStack.at(-1)
    if (!snapshot) return
    setUndoStack((items) => items.slice(0, -1))
    restoreSnapshot(snapshot, setRedoStack)
  }, [restoreSnapshot, undoStack])

  const redo = useCallback(() => {
    const snapshot = redoStack.at(-1)
    if (!snapshot) return
    setRedoStack((items) => items.slice(0, -1))
    restoreSnapshot(snapshot, setUndoStack)
  }, [redoStack, restoreSnapshot])

  const changeInspectorTab = useCallback((tab) => {
    setInspectorTab(tab)
    mutate((draft) => { draft.presentation.inspectorTab = tab }, { history: false, label: 'Preserve inspector tab' })
  }, [mutate])

  const changeRunTab = useCallback((tab) => {
    setRunTab(tab)
    mutate((draft) => { draft.presentation.runTab = tab }, { history: false, label: 'Preserve run tab' })
  }, [mutate])

  const revealDiagnostic = useCallback((item) => {
    if (item.target?.kind === 'node' && item.target.id) {
      setSelectedIds([item.target.id])
      setSelectedEdge(null)
      setInspectorOpen(true)
      setInspectorTab('settings')
      mutate((draft) => { draft.presentation.activeMode = 'graph' }, { history: false })
      return
    }
    setSourceTab(item.source === 'integration' || item.source === 'product' ? 'integration' : 'method')
    setInspectorOpen(false)
    mutate((draft) => { draft.presentation.activeMode = 'source' }, { history: false })
  }, [mutate])

  const confirmSourceApplied = useCallback((tab, value) => {
    const current = stateRef.current
    if (current && JSON.stringify(current.document[tab]) === JSON.stringify(value)) {
      setSourceDrafts(({ [tab]: _discard, ...rest }) => rest)
    }
  }, [])

  const save = useCallback(async () => {
    if (!stateRef.current) return
    await mutationQueue.current.catch(() => {})
    if (!stateRef.current) return
    setBusy(true)
    try {
      const response = await api('/api/project/save', json('POST', { expectedRevision: stateRef.current.revision }))
      applyState(response.state, response.runs)
      setNotice({ kind: 'success', title: 'Source saved', message: 'Canonical files were written atomically and re-bound to this draft.' })
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }, [applyState, refresh, showError])

  const reconcileSource = useCallback(async () => {
    if (!stateRef.current) return
    setBusy(true)
    try {
      const response = await api('/api/project/reconcile', json('POST', { expectedRevision: stateRef.current.revision }))
      applyState(response.state, response.runs)
      setSelectedIds(response.state.presentation.selection ?? [])
      setProposalSelection(new Set(response.state.proposal?.changes.map((item) => item.id) ?? []))
      setInspectorTab('changes')
      setInspectorOpen(true)
      setModal(null)
      setUndoStack([])
      setRedoStack([])
      setSourceDrafts({})
      setCanvasEpoch((epoch) => epoch + 1)
      setNotice({ kind: 'success', title: 'Draft preserved for review', message: 'Disk source is current; your prior draft is now a semantic change set you can accept or reject.' })
    } catch (error) {
      showError(error)
      if (error.code === 'STUDIO_SOURCE_CONFLICT') await refresh().catch(() => {})
    } finally {
      setBusy(false)
    }
  }, [applyState, showError])

  const reloadSource = useCallback(async () => {
    if (!stateRef.current) return
    setBusy(true)
    try {
      const response = await api('/api/project/reload', json('POST', { expectedRevision: stateRef.current.revision }))
      applyState(response.state, response.runs)
      setSelectedIds([])
      setSelectedEdge(null)
      setModal(null)
      setUndoStack([])
      setRedoStack([])
      setSourceDrafts({})
      setCanvasEpoch((epoch) => epoch + 1)
      setNotice({ kind: 'success', title: 'Source reloaded', message: 'The private draft was discarded and the latest canonical files are open.' })
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }, [applyState, showError])

  const persistScenarioDraft = useCallback(async () => {
    if (!scenarioDirty || !scenarioDraft || scenarioDraft.id !== scenarioId) return true
    const response = await api(`/api/project/scenario/${encodeURIComponent(scenarioDraft.id)}`, json('PUT', {
      expectedRevision: stateRef.current.revision,
      candidate: scenarioDraft,
    }))
    applyState(response.state, response.runs)
    setScenarioDraft(structuredClone(response.state.scenarios.find((item) => item.id === scenarioDraft.id)))
    setScenarioDirty(false)
    return true
  }, [applyState, scenarioDirty, scenarioDraft, scenarioId])

  const reloadScenarioSources = useCallback(async () => {
    const response = await api('/api/project/scenarios/reload', json('POST', { expectedRevision: stateRef.current.revision }))
    applyState(response.state, response.runs)
    const selected = response.state.scenarios.find((item) => item.id === scenarioId) ?? response.state.scenarios[0] ?? null
    setScenarioId(selected?.id ?? null)
    setScenarioDraft(selected ? structuredClone(selected) : null)
    setScenarioDirty(false)
    setNotice({ kind: 'info', title: 'External scenario reloaded', message: 'The changed scenario file is now open; the stale private scenario draft was not written.' })
  }, [applyState, scenarioId])

  const saveScenarioDraft = useCallback(async () => {
    if (!scenarioDirty) return
    setBusy(true)
    try {
      await mutationQueue.current.catch(() => {})
      await persistScenarioDraft()
      setNotice({ kind: 'success', title: 'Scenario saved', message: `${scenarioDraft.name} is ready for repeatable Test Runs.` })
    } catch (error) {
      if (error.code === 'STUDIO_SCENARIO_CONFLICT') await reloadScenarioSources().catch(showError)
      else showError(error)
    } finally {
      setBusy(false)
    }
  }, [persistScenarioDraft, reloadScenarioSources, scenarioDirty, scenarioDraft?.name, showError])

  const selectScenario = useCallback(async (nextId) => {
    try {
      await mutationQueue.current.catch(() => {})
      await persistScenarioDraft()
      setScenarioId(nextId)
    } catch (error) {
      if (error.code === 'STUDIO_SCENARIO_CONFLICT') await reloadScenarioSources().catch(showError)
      else showError(error)
    }
  }, [persistScenarioDraft, reloadScenarioSources, showError])

  const startRun = useCallback(async () => {
    if (!scenarioId) return
    await mutationQueue.current.catch(() => {})
    if (!stateRef.current) return
    const blockers = scenarioReadiness(stateRef.current, scenarioDraft).filter((item) => item.severity === 'error')
    if (blockers.length) {
      setRunTab('input')
      setRunExpanded(true)
      if (!stateRef.current.presentation.runPanelOpen) mutate((draft) => { draft.presentation.runPanelOpen = true }, { history: false, label: 'Open Test Run setup' })
      setNotice({ kind: 'error', title: 'Run setup needs attention', message: blockers[0].message })
      return
    }
    setBusy(true)
    try {
      await persistScenarioDraft()
      const response = await api('/api/runs', json('POST', { scenarioId }))
      setRuns(response.runs)
      setSelectedRunId(response.run.id)
      setRunDetail(response.run)
      if (!studio.presentation.runPanelOpen) mutate((draft) => { draft.presentation.runPanelOpen = true }, { history: false, label: 'Open Test Run' })
      const scenario = response.run && studio.scenarios.find((item) => item.id === scenarioId)
      setNotice({ kind: 'success', title: 'Test Run started', message: `${scenario?.name ?? scenarioId} is executing against this exact source digest.` })
    } catch (error) {
      if (error.code === 'STUDIO_SCENARIO_CONFLICT') await reloadScenarioSources().catch(showError)
      else showError(error)
    } finally {
      setBusy(false)
    }
  }, [mutate, persistScenarioDraft, reloadScenarioSources, scenarioDraft, scenarioId, showError, studio?.presentation.runPanelOpen])

  const refreshRun = useCallback(async () => {
    if (!selectedRunId) return
    try {
      const response = await api(`/api/runs/${selectedRunId}`)
      setRunDetail(response.run)
      const list = await api('/api/runs')
      setRuns(list.runs)
    } catch (error) {
      if (error.code !== 'STUDIO_RUN_NOT_FOUND') showError(error)
    }
  }, [selectedRunId, showError])

  useEffect(() => {
    if (!selectedRunId) {
      setRunDetail(null)
      return undefined
    }
    refreshRun()
    const settled = runDetail !== null && ['complete', 'cancelled'].includes(runDetail.status)
    const timer = setInterval(refreshRun, settled ? 2400 : 800)
    return () => clearInterval(timer)
  }, [refreshRun, runDetail?.status, selectedRunId])

  const runAction = useCallback(async (action) => {
    if (!selectedRunId) return
    setBusy(true)
    try {
      const response = await api(`/api/runs/${selectedRunId}/action`, json('POST', action))
      setRunDetail(response.run)
      setRuns(response.runs)
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }, [selectedRunId, showError])

  const replay = useCallback(async (nodeId) => {
    if (!selectedRunId || !nodeId) return
    await mutationQueue.current.catch(() => {})
    setBusy(true)
    try {
      const response = await api(`/api/runs/${selectedRunId}/replay`, json('POST', { nodeId }))
      setRunDetail(response.run)
      setSelectedRunId(response.run.id)
      setRuns(response.runs)
      setNotice({ kind: 'success', title: 'Replay created', message: `A new Run resumed at ${nodeId}; the original Run is unchanged.` })
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }, [selectedRunId, showError])

  const packageCandidate = useCallback(async () => {
    if (!stateRef.current) return
    await mutationQueue.current.catch(() => {})
    if (!stateRef.current) return
    modalReturnFocus.current = document.activeElement
    setBusy(true)
    try {
      const response = await api('/api/package', json('POST', { expectedRevision: stateRef.current.revision }))
      applyState(response.state, response.runs)
      setModal({ kind: 'package', result: response.package })
    } catch (error) {
      showError(error)
      if (error.code === 'STUDIO_SOURCE_CONFLICT') await refresh().catch(() => {})
    } finally {
      setBusy(false)
    }
  }, [applyState, refresh, showError])

  const addNode = useCallback((kind, position = null) => {
    mutate((draft) => {
      if (kind === 'agent-turn' && draft.document.method.roles.length === 0) {
        draft.document.method.roles.push({ id: 'agent', name: 'Agent', independentFrom: [], includeReports: false, defaultBinding: { provider: 'codex' } })
      }
      if (kind === 'human-input' && draft.document.method.artifacts.length === 0) {
        draft.document.method.artifacts.push({ id: 'answer', name: 'Answer', type: 'text', required: false })
      }
      const node = defaultNode(kind, draft.document.method)
      draft.document.method.graph.nodes.push(node)
      draft.presentation.positions[node.id] = position ?? { x: 120 + (draft.document.method.graph.nodes.length % 4) * 42, y: 120 + draft.document.method.graph.nodes.length * 34 }
      draft.presentation.selection = [node.id]
      setSelectedIds([node.id])
      setSelectedEdge(null)
    }, { label: `Add ${KIND_LABEL[kind]}` })
  }, [mutate])

  const updateNode = useCallback((nodeId, updater, label = 'Edit node') => {
    mutate((draft) => {
      const node = draft.document.method.graph.nodes.find((item) => item.id === nodeId)
      if (node) updater(node, draft.document.method)
    }, { label })
  }, [mutate])

  const removeSelection = useCallback(() => {
    if (!studio || (selectedIds.length === 0 && !selectedEdge)) return
    mutate((draft) => {
      const next = deleteSelection(draft.document, draft.presentation, selectedIds, selectedEdge)
      draft.document = next.document
      draft.presentation = next.presentation
      setSelectedIds([])
      setSelectedEdge(null)
    }, { label: 'Delete selection' })
  }, [mutate, selectedEdge, selectedIds, studio])

  const copy = useCallback(() => {
    if (!studio || selectedIds.length === 0) return
    setCopied(cloneSelection(studio.document, studio.presentation, selectedIds))
    setNotice({ kind: 'info', title: 'Copied', message: `${selectedIds.length} graph object${selectedIds.length === 1 ? '' : 's'} ready to paste.` })
  }, [selectedIds, studio])

  const paste = useCallback(() => {
    if (!copied) return
    mutate((draft) => {
      const next = pasteSelection(draft.document, draft.presentation, copied)
      draft.document = next.document
      draft.presentation = next.presentation
      setSelectedIds(next.selectedIds)
    }, { label: 'Paste graph objects' })
  }, [copied, mutate])

  const align = useCallback((axis) => {
    if (selectedIds.length < 2) return
    mutate((draft) => {
      const points = selectedIds.map((id) => draft.presentation.positions[id]).filter(Boolean)
      const average = points.reduce((sum, point) => sum + point[axis], 0) / points.length
      for (const id of selectedIds) if (draft.presentation.positions[id]) draft.presentation.positions[id][axis] = average
    }, { label: `Align ${axis === 'x' ? 'vertically' : 'horizontally'}` })
  }, [mutate, selectedIds])

  const distribute = useCallback((axis) => {
    if (selectedIds.length < 3) return
    mutate((draft) => {
      const ordered = selectedIds.map((id) => ({ id, ...draft.presentation.positions[id] })).filter((item) => Number.isFinite(item[axis])).sort((a, b) => a[axis] - b[axis])
      const gap = (ordered.at(-1)[axis] - ordered[0][axis]) / (ordered.length - 1)
      ordered.forEach((item, index) => { draft.presentation.positions[item.id][axis] = ordered[0][axis] + gap * index })
    }, { label: `Distribute ${axis === 'x' ? 'horizontally' : 'vertically'}` })
  }, [mutate, selectedIds])

  const autoArrange = useCallback(() => {
    mutate((draft) => {
      const result = arrangeMethodPositions(draft.document.method, draft.presentation.positions, selectedIds[0])
      if (result.error) {
        setNotice({ kind: 'error', title: 'Graph arrangement unavailable', message: result.error.message })
        return
      }
      draft.presentation.positions = result.positions
    }, { label: 'Auto arrange graph' })
  }, [mutate, selectedIds])

  const [scenarioName, setScenarioName] = useState('')
  const [canvasEpoch, setCanvasEpoch] = useState(0)

  const createScenario = useCallback(async (candidate, description) => {
    if (!candidate || !scenarioName.trim()) return
    setBusy(true)
    try {
      const response = await api('/api/project/scenario', json('POST', {
        expectedRevision: stateRef.current.revision,
        name: scenarioName.trim(),
        description,
        inputs: candidate.inputs,
        grants: candidate.grants,
        resources: candidate.resources,
        limits: candidate.limits,
        bindings: candidate.bindings,
      }))
      applyState(response.state, response.runs)
      setScenarioId(response.state.scenarios.at(-1)?.id ?? null)
      setScenarioDraft(structuredClone(response.state.scenarios.at(-1)))
      setScenarioDirty(false)
      setScenarioName('')
      setNotice({ kind: 'success', title: 'Test scenario created', message: `${scenarioName.trim()} is now an independently editable project scenario.` })
    } catch (error) {
      showError(error)
      if (error.code === 'STUDIO_SOURCE_CONFLICT') await refresh().catch(() => {})
    } finally {
      setBusy(false)
    }
  }, [applyState, refresh, scenarioName, showError])

  const saveScenario = useCallback((run) => createScenario(run?.request, run ? `Captured from Test Run ${run.runId}` : undefined), [createScenario])
  const duplicateScenario = useCallback((scenario) => createScenario(scenario, scenario?.description), [createScenario])

  const loadProposal = useCallback(async () => {
    try {
      const candidate = JSON.parse(proposalText)
      setBusy(true)
      const response = await api('/api/proposal', json('POST', { expectedRevision: stateRef.current.revision, candidate }))
      applyState(response.state, response.runs)
      setProposalSelection(new Set(response.state.proposal.changes.map((item) => item.id)))
      setInspectorTab('changes')
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }, [applyState, proposalText, showError])

  const decideProposal = useCallback(async (decision) => {
    const ids = [...proposalSelection]
    if (ids.length === 0) return
    setBusy(true)
    try {
      const response = await api('/api/proposal/decision', json('POST', {
        expectedRevision: stateRef.current.revision,
        [decision]: ids,
        [decision === 'accept' ? 'reject' : 'accept']: [],
      }))
      applyState(response.state, response.runs)
      setProposalSelection(new Set())
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }, [applyState, proposalSelection, showError])

  useEffect(() => {
    const key = (event) => {
      if (modal) return
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable
      const command = event.metaKey || event.ctrlKey
      if (command && event.key.toLowerCase() === 's') {
        event.preventDefault()
        save()
      } else if (command && event.key === 'Enter' && !editing) {
        event.preventDefault()
        startRun()
      } else if (command && event.key.toLowerCase() === 'z' && !editing && !event.shiftKey) {
        event.preventDefault()
        undo()
      } else if (((command && event.key.toLowerCase() === 'z' && event.shiftKey) || (event.ctrlKey && event.key.toLowerCase() === 'y')) && !editing) {
        event.preventDefault()
        redo()
      } else if (!editing && command && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        copy()
      } else if (!editing && command && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        paste()
      } else if (!editing && ['Backspace', 'Delete'].includes(event.key)) {
        event.preventDefault()
        removeSelection()
      } else if (!editing && !modal && selectedIds.length > 0 && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault()
        const step = event.shiftKey ? 1 : 24
        mutate((draft) => {
          for (const id of selectedIds) {
            const position = draft.presentation.positions[id]
            if (!position) continue
            if (event.key === 'ArrowUp') position.y -= step
            else if (event.key === 'ArrowDown') position.y += step
            else if (event.key === 'ArrowLeft') position.x -= step
            else position.x += step
          }
        }, { label: 'Move selection' })
      } else if (!editing && event.key.toLowerCase() === 'g') {
        mutate((draft) => { draft.presentation.activeMode = 'graph' }, { history: false })
      } else if (!editing && event.key.toLowerCase() === 's') {
        mutate((draft) => { draft.presentation.activeMode = 'source' }, { history: false })
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [copy, modal, mutate, paste, redo, removeSelection, save, selectedIds, startRun, undo])

  const selectedNode = studio?.document.method.graph.nodes.find((node) => selectedIds.length === 1 && node.id === selectedIds[0]) ?? null
  const selectedTransition = useMemo(() => {
    if (!selectedEdge || !studio) return null
    return findTransition(studio.document.method, selectedEdge)
  }, [selectedEdge, studio])

  if (!studio) return <div className="loading-screen"><LoaderCircle className="spin" size={26} /><span>Opening canonical Procedure source…</span>{notice && <p>{notice.message}</p>}</div>

  const invalid = !studio.validation.valid
  const sourceSaved = studio.source.saved
  const activeMode = studio.presentation.activeMode

  return (
    <div className={`app-shell ${studio.presentation.runPanelOpen ? 'run-open' : ''}`}>
      <header className="topbar">
        <div className="product-lockup">
          <span className="product-mark"><Waypoints size={18} /></span>
          <div>
            <span className="eyebrow">Procedure Studio</span>
            <strong>{studio.document.integration.displayName}</strong>
          </div>
        </div>
        <div className="identity-block">
          <span>{studio.document.integration.procedure.id}</span>
          <b>v{studio.document.integration.procedure.version}</b>
          {studio.source.conflict
            ? <button className="source-state conflict" type="button" onClick={(event) => { modalReturnFocus.current = event.currentTarget; setModal({ kind: 'source-conflict' }) }}><CircleAlert size={12} />Source conflict</button>
            : <span className={`source-state ${sourceSaved ? 'saved' : 'draft'}`}><CircleDot size={10} />{sourceSaved ? 'Saved' : 'Draft'}</span>}
          <button className={`validation-pill ${invalid ? 'invalid' : 'valid'}`} onClick={() => { setInspectorTab('validation'); setInspectorOpen(true) }} type="button">
            {invalid ? <CircleAlert size={13} /> : <CheckCircle2 size={13} />}
            {invalid ? `${studio.validation.diagnostics.length} ${studio.validation.diagnostics.length === 1 ? 'issue' : 'issues'}` : 'Valid'}
          </button>
        </div>
        <div className="mode-switch" role="group" aria-label="Editor mode">
          <button type="button" className={activeMode === 'graph' ? 'active' : ''} onClick={() => mutate((draft) => { draft.presentation.activeMode = 'graph' }, { history: false })}><LayoutGrid size={14} />Graph</button>
          <button type="button" className={activeMode === 'source' ? 'active' : ''} onClick={() => mutate((draft) => { draft.presentation.activeMode = 'source' }, { history: false })}><Code2 size={14} />Source</button>
        </div>
        <div className="top-actions">
          <IconButton label="Undo" onClick={undo} disabled={!undoStack.length || busy}><Undo2 size={16} /></IconButton>
          <IconButton label="Redo" onClick={redo} disabled={!redoStack.length || busy}><Redo2 size={16} /></IconButton>
          <button className="button quiet" type="button" onClick={save} disabled={busy}><Save size={15} />Save</button>
          <button className="button primary" type="button" onClick={startRun} disabled={busy || invalid || !scenarioId}><Play size={15} />Test</button>
          <button className="button dark" type="button" onClick={packageCandidate} disabled={busy || invalid}><Archive size={15} />Package</button>
          <IconButton label={inspectorOpen ? 'Hide inspector' : 'Show inspector'} onClick={() => setInspectorOpen(!inspectorOpen)}><Settings2 size={16} /></IconButton>
        </div>
      </header>

      <nav className="activity-rail" aria-label="Workspace tools" aria-hidden={runExpanded} inert={runExpanded ? true : undefined}>
        <button type="button" className={leftOpen && leftTab === 'library' ? 'active' : ''} aria-label="Object library" title="Object library" onClick={() => { setLeftTab('library'); setLeftOpen(leftTab !== 'library' || !leftOpen) }}><Boxes size={18} /></button>
        <button type="button" className={leftOpen && leftTab === 'structure' ? 'active' : ''} aria-label="Procedure structure" title="Procedure structure" onClick={() => { setLeftTab('structure'); setLeftOpen(leftTab !== 'structure' || !leftOpen) }}><Waypoints size={18} /></button>
        <span />
        <button type="button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" onClick={(event) => { modalReturnFocus.current = event.currentTarget; setModal({ kind: 'shortcuts' }) }}><Keyboard size={18} /></button>
      </nav>

      <aside className={`left-panel ${leftOpen ? 'open' : ''}`} aria-hidden={runExpanded || !leftOpen} inert={runExpanded || !leftOpen ? true : undefined}>
        <header className="drawer-header"><div><span className="eyebrow">Add and navigate</span><h2>{leftTab === 'library' ? 'Object library' : 'Procedure structure'}</h2></div><IconButton label="Close left drawer" onClick={() => setLeftOpen(false)}><X size={16} /></IconButton></header>
        <div className="panel-tabs compact-tabs" role="tablist" aria-label="Left drawer sections">
          <button className={leftTab === 'library' ? 'active' : ''} onClick={() => setLeftTab('library')} type="button" role="tab" aria-selected={leftTab === 'library'}>Library</button>
          <button className={leftTab === 'structure' ? 'active' : ''} onClick={() => setLeftTab('structure')} type="button" role="tab" aria-selected={leftTab === 'structure'}>Structure</button>
        </div>
        <label className="search-box"><Search size={14} /><input aria-label="Search objects" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search objects" /></label>
        {leftTab === 'library' ? (
          <div className="library-list">
            {NODE_LIBRARY.filter((item) => `${item.name} ${item.group} ${item.description}`.toLowerCase().includes(search.toLowerCase())).map((item) => {
              const Icon = NODE_ICONS[item.kind]
              return (
                <button
                  className="library-item"
                  key={item.kind}
                  type="button"
                  draggable
                  onDragStart={(event) => { event.dataTransfer.setData('application/procedure-node', item.kind); event.dataTransfer.effectAllowed = 'copy' }}
                  onClick={() => addNode(item.kind)}
                >
                  <span className="library-icon"><Icon size={16} /></span>
                  <span><b>{item.name}</b><small>{item.description}</small></span>
                  <Plus size={15} />
                </button>
              )
            })}
            <div className="section-label">Reserved extensions</div>
            {UNSUPPORTED_EXTENSIONS.map((item) => (
              <div className="library-item unavailable" key={item.kind} aria-disabled="true">
                <span className="library-icon"><Pause size={15} /></span>
                <span><b>{item.name}</b><small>{item.description}</small></span>
              </div>
            ))}
          </div>
        ) : (
          <nav className="structure-tree" aria-label="Procedure structure">
            <button type="button" onClick={() => { setSelectedIds([]); setSelectedEdge(null); setInspectorOpen(true) }}><Box size={14} /><b>{studio.document.method.name}</b><span>{studio.document.method.graph.nodes.length}</span></button>
            {studio.document.method.graph.nodes.filter((node) => `${node.name} ${node.id} ${node.kind}`.toLowerCase().includes(search.toLowerCase())).map((node) => {
              const Icon = NODE_ICONS[node.kind]
              const diagnostic = studio.validation.diagnostics.some((item) => item.target?.id === node.id)
              return <button type="button" className={selectedIds.includes(node.id) ? 'selected' : ''} key={node.id} onClick={() => { setSelectedIds([node.id]); setSelectedEdge(null); setInspectorOpen(true); setInspectorTab('settings') }}><Icon size={13} /><span>{node.name}</span>{diagnostic ? <CircleAlert className="danger" size={13} /> : null}</button>
            })}
            <div className="tree-section"><Braces size={13} />Contracts</div>
            {studio.document.method.inputs.map((item) => <div className="tree-leaf" key={`in-${item.id}`}><span>IN</span>{item.id}</div>)}
            {studio.document.method.artifacts.map((item) => <div className="tree-leaf" key={`out-${item.id}`}><span>ART</span>{item.id}</div>)}
          </nav>
        )}
        <div className="shortcut-card"><Keyboard size={15} /><span><b>Keyboard ready</b><small>⌘S save · ⌘↵ test · ⌘C/V · Delete · G/S modes</small></span></div>
      </aside>

      <main className="workspace" aria-hidden={runExpanded} inert={runExpanded ? true : undefined}>
        {activeMode === 'graph' ? (
          <GraphWorkspace
            studio={studio}
            runStates={runDetail?.nodes.map((node) => `${node.id}:${node.state}`).join('|') ?? ''}
            zoom={zoom}
            setZoom={setZoom}
            selectedIds={selectedIds}
            setSelectedIds={setSelectedIds}
            selectedEdge={selectedEdge}
            setSelectedEdge={setSelectedEdge}
            mutate={mutate}
            addNode={addNode}
            onDelete={removeSelection}
            onCopy={copy}
            onPaste={paste}
            copied={copied}
            align={align}
            distribute={distribute}
            autoArrange={autoArrange}
            openInspector={() => { setInspectorOpen(true); setInspectorTab('settings') }}
            canvasEpoch={canvasEpoch}
          />
        ) : (
          <SourceWorkspace
            key={sourceTab}
            studio={studio}
            tab={sourceTab}
            setTab={setSourceTab}
            mutate={mutate}
            showError={showError}
            draft={sourceDrafts[sourceTab] ?? null}
            onDraft={(key, text) => setSourceDrafts((current) => ({ ...current, [key]: text }))}
            clearDraft={(key) => setSourceDrafts(({ [key]: _discard, ...rest }) => rest)}
            confirmApplied={confirmSourceApplied}
          />
        )}
      </main>

      <aside className={`inspector ${inspectorOpen ? 'open' : ''}`} aria-hidden={runExpanded || !inspectorOpen} inert={runExpanded || !inspectorOpen ? true : undefined}>
        <Inspector
          studio={studio}
          selectedNode={selectedNode}
          selectedIds={selectedIds}
          selectedTransition={selectedTransition}
          tab={inspectorTab}
          setTab={changeInspectorTab}
          updateNode={updateNode}
          mutate={mutate}
          showError={showError}
          run={runDetail}
          setSelectedIds={setSelectedIds}
          setSelectedEdge={setSelectedEdge}
          revealDiagnostic={revealDiagnostic}
          proposalText={proposalText}
          setProposalText={setProposalText}
          loadProposal={loadProposal}
          proposalSelection={proposalSelection}
          setProposalSelection={setProposalSelection}
          decideProposal={decideProposal}
          close={() => setInspectorOpen(false)}
        />
      </aside>

      {studio.presentation.runPanelOpen ? (
        <RunPanel
          studio={studio}
          runs={runs}
          selectedRunId={selectedRunId}
          setSelectedRunId={setSelectedRunId}
          run={runDetail}
          tab={runTab}
          setTab={changeRunTab}
          scenarioId={scenarioId}
          setScenarioId={selectScenario}
          scenarioDraft={scenarioDraft}
          setScenarioDraft={(updater) => { setScenarioDraft(updater); setScenarioDirty(true) }}
          scenarioDirty={scenarioDirty}
          saveScenarioDraft={saveScenarioDraft}
          scenarioName={scenarioName}
          setScenarioName={setScenarioName}
          saveScenario={saveScenario}
          duplicateScenario={duplicateScenario}
          startRun={startRun}
          action={runAction}
          replay={replay}
          selectedNodeId={selectedIds.length === 1 ? selectedIds[0] : null}
          selectNode={(id) => { setSelectedIds([id]); setSelectedEdge(null) }}
          close={() => { setRunExpanded(false); mutate((draft) => { draft.presentation.runPanelOpen = false }, { history: false }) }}
          expanded={runExpanded}
          setExpanded={setRunExpanded}
        />
      ) : (
        <button className="run-reopen" type="button" onClick={() => mutate((draft) => { draft.presentation.runPanelOpen = true }, { history: false })}><PanelBottomOpen size={15} />Test Runs</button>
      )}

      {notice && <div className={`toast ${notice.kind}`} role="status"><span>{notice.kind === 'error' ? <XCircle size={17} /> : notice.kind === 'success' ? <CheckCircle2 size={17} /> : <CircleDot size={17} />}</span><div><b>{notice.title}</b><p>{notice.message}</p></div><IconButton label="Dismiss" onClick={() => setNotice(null)}><X size={14} /></IconButton></div>}
      {busy && <div className="busy-indicator"><LoaderCircle className="spin" size={14} />Working…</div>}
      {modal && <Modal onClose={() => setModal(null)} returnFocus={modalReturnFocus.current}>{modal.kind === 'package' && <PackageResult result={modal.result} />}{modal.kind === 'shortcuts' && <ShortcutGuide />}{modal.kind === 'source-conflict' && <SourceConflictRecovery reconcile={reconcileSource} reload={reloadSource} busy={busy} />}</Modal>}
    </div>
  )
}

function GraphWorkspace({ studio, runStates, zoom, setZoom, selectedIds, setSelectedIds, selectedEdge, setSelectedEdge, mutate, addNode, onDelete, onCopy, onPaste, copied, align, distribute, autoArrange, openInspector, canvasEpoch }) {
  const reactFlow = useReactFlow()
  const runNodes = useMemo(() => (runStates ? runStates.split('|').map((entry) => { const [id, state] = entry.split(':'); return { id, state } }) : []), [runStates])
  const [livePositions, setLivePositions] = useState(() => structuredClone(studio.presentation.positions))
  const previousPlan = useRef(null)
  const selectionSyncUntil = useRef(0)
  useEffect(() => {
    setLivePositions(structuredClone(studio.presentation.positions))
  }, [studio.presentation.positions])
  const view = useMemo(() => flowView(
    studio.document.method,
    { ...studio.presentation, positions: livePositions },
    { nodes: runNodes },
    zoom,
    previousPlan.current,
  ), [livePositions, runNodes, studio.document.method, studio.presentation, zoom])
  useEffect(() => {
    if (view.plan) previousPlan.current = view.plan
  }, [view.plan])
  const nodes = useMemo(() => view.nodes.map((node) => ({ ...node, selected: selectedIds.includes(node.id) })), [selectedIds, view.nodes])
  const edges = useMemo(() => view.edges.map((edge) => ({ ...edge, markerEnd: { type: MarkerType.ArrowClosed } })), [view.edges])
  useEffect(() => {
    if (!canvasEpoch) return undefined
    const timer = setTimeout(() => { reactFlow.fitView({ padding: 0.22, duration: 240 }) }, 80)
    return () => clearTimeout(timer)
  }, [canvasEpoch, reactFlow])
  const onNodesChange = useCallback((changes) => {
    const selectionChanges = changes.filter((change) => change.type === 'select')
    if (selectionChanges.length) {
      setSelectedIds((current) => {
        const next = new Set(current)
        for (const change of selectionChanges) {
          if (change.selected) next.add(change.id)
          else next.delete(change.id)
        }
        return [...next]
      })
      if (selectionChanges.some((change) => change.selected)) setSelectedEdge(null)
    }
    const moved = changes.filter((change) => change.type === 'position' && change.position)
    if (!moved.length) return
    setLivePositions((current) => {
      const next = { ...current }
      for (const change of moved) next[change.id] = change.position
      return next
    })
  }, [setSelectedEdge, setSelectedIds])
  const onNodeDragStop = useCallback((_event, node, group) => {
    const moved = group?.length ? group : [node]
    setLivePositions((current) => ({ ...current, ...Object.fromEntries(moved.map((item) => [item.id, item.position])) }))
    mutate((draft) => {
      for (const item of moved) draft.presentation.positions[item.id] = item.position
    }, { history: true, label: 'Move graph objects' })
  }, [mutate])
  const onConnect = useCallback((connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return
    mutate((draft) => {
      const source = draft.document.method.graph.nodes.find((node) => node.id === connection.source)
      if (!source || source.transitions.some((route) => route.to === connection.target)) return
      const open = source.transitions.find((route) => route.to === null)
      if (open) open.to = connection.target
      else source.transitions.push({ id: nextTransitionId(draft.document.method, source.id), when: { operator: 'always' }, to: connection.target })
    }, { label: 'Connect nodes' })
  }, [mutate])
  const selectNodes = useCallback((ids) => {
    setSelectedIds((current) => current.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)
  }, [setSelectedIds])
  const drop = useCallback((event) => {
    event.preventDefault()
    const kind = event.dataTransfer.getData('application/procedure-node')
    if (!NODE_LIBRARY.some((item) => item.kind === kind)) return
    addNode(kind, reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
  }, [addNode, reactFlow])
  const viewport = studio.presentation.viewport
  return (
    <div className="graph-workspace" onDrop={drop} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}>
      <div className="canvas-toolbar" aria-label="Graph operations">
        <IconButton label="Copy selection" onClick={onCopy} disabled={!selectedIds.length}><Copy size={15} /></IconButton>
        <IconButton label="Paste" onClick={onPaste} disabled={!copied}><Clipboard size={15} /></IconButton>
        <span className="toolbar-divider" />
        <IconButton label="Align vertical centers" onClick={() => align('x')} disabled={selectedIds.length < 2}><AlignVerticalSpaceAround size={15} /></IconButton>
        <IconButton label="Align horizontal centers" onClick={() => align('y')} disabled={selectedIds.length < 2}><AlignHorizontalSpaceAround size={15} /></IconButton>
        <IconButton label="Distribute horizontally" onClick={() => distribute('x')} disabled={selectedIds.length < 3}><MoveHorizontal size={15} /></IconButton>
        <IconButton label="Distribute vertically" onClick={() => distribute('y')} disabled={selectedIds.length < 3}><MoveVertical size={15} /></IconButton>
        <IconButton label="Auto arrange graph" onClick={autoArrange}><LayoutGrid size={15} /></IconButton>
        <IconButton label="Delete selection" onClick={onDelete} disabled={!selectedIds.length && !selectedEdge}><Trash2 size={15} /></IconButton>
        <span className={`graph-quality ${view.compileError ? 'error' : view.diagnostics.length ? 'warning' : 'good'}`} title={view.compileError?.message ?? view.diagnostics.map((item) => item.message).join('\n')}><CircleAlert size={13} />{view.compileError ? 'Route fallback' : view.diagnostics.length ? view.diagnostics.length : 'Compiled'}</span>
        <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(event, node) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) {
            selectNodes(selectedIds.includes(node.id) ? selectedIds.filter((id) => id !== node.id) : [...selectedIds, node.id])
          } else {
            selectNodes([node.id])
          }
          setSelectedEdge(null)
        }}
        onNodeDragStart={(_event, node) => {
          if (!selectedIds.includes(node.id)) selectNodes([node.id])
          setSelectedEdge(null)
        }}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onSelectionChange={({ nodes: selected }) => {
          if (Date.now() < selectionSyncUntil.current) return
          if (selected.length === 0) return
          selectNodes(selected.map((node) => node.id))
          setSelectedEdge(null)
        }}
        onNodeDoubleClick={() => openInspector()}
        onEdgeClick={(_event, edge) => { setSelectedEdge(edge.id); selectNodes([]); openInspector() }}
        onPaneClick={() => {
          selectionSyncUntil.current = Date.now() + 120
          selectNodes([])
          setSelectedEdge(null)
        }}
        defaultViewport={viewport}
        minZoom={0.2}
        maxZoom={2}
        selectionOnDrag
        panOnDrag={[1, 2]}
        multiSelectionKeyCode={["Meta", "Control", "Shift"]}
        deleteKeyCode={null}
        fitView={!viewport || viewport.zoom === 1 && viewport.x === 0 && viewport.y === 0}
        onMoveEnd={(_event, next) => {
          setZoom(next.zoom)
          const prior = studio.presentation.viewport
          if (Math.abs(prior.x - next.x) + Math.abs(prior.y - next.y) + Math.abs(prior.zoom - next.zoom) > 1) {
            mutate((draft) => { draft.presentation.viewport = next }, { history: false, label: 'Navigate canvas' })
          }
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#d7dce4" gap={20} size={1} />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap position="bottom-right" pannable zoomable nodeColor={(node) => node.data.runState === 'failed' ? '#dc4b4b' : node.selected ? '#246bfd' : '#a9b2c0'} maskColor="rgba(245,247,250,.72)" />
      </ReactFlow>
    </div>
  )
}

function SourceWorkspace({ studio, tab, setTab, mutate, showError, draft, onDraft, clearDraft, confirmApplied }) {
  const source = studio.document[tab]
  const canonical = useMemo(() => JSON.stringify(source, null, 2), [source])
  const [text, setText] = useState(draft ?? canonical)
  const lastCanonical = useRef(canonical)
  useEffect(() => {
    if (canonical === lastCanonical.current) return
    lastCanonical.current = canonical
    if (draft === null) setText(canonical)
  }, [canonical, draft])
  const apply = async () => {
    let value
    try {
      value = JSON.parse(text)
    } catch (error) {
      showError({ code: 'INVALID_JSON', message: error.message })
      return
    }
    await mutate((current) => { current.document[tab] = value }, { label: `Edit ${tab} source` })
    confirmApplied(tab, value)
  }
  return (
    <section className="source-workspace">
      <header>
        <div className="source-tabs" role="tablist" aria-label="Canonical source files">
          {['method', 'integration', 'inputSchema', 'outputSchema'].map((value) => <button type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)} key={value}>{value === 'inputSchema' ? 'Input schema' : value === 'outputSchema' ? 'Output schema' : value[0].toUpperCase() + value.slice(1)}</button>)}
        </div>
        <div><span className="source-path"><FileJson2 size={13} />{studio.source.paths[tab]}</span><button className="button primary small" type="button" onClick={apply}>Apply source</button></div>
      </header>
      <textarea className="code-editor" aria-label={`${tab} JSON source`} spellCheck="false" value={text} onChange={(event) => { setText(event.target.value); onDraft(tab, event.target.value) }} />
      <footer><span>Canonical source · unknown fields fail closed</span><span>{text.split('\n').length} lines</span></footer>
    </section>
  )
}

function Inspector({ studio, selectedNode, selectedIds, selectedTransition, tab, setTab, updateNode, mutate, showError, run, setSelectedIds, setSelectedEdge, revealDiagnostic, proposalText, setProposalText, loadProposal, proposalSelection, setProposalSelection, decideProposal, close }) {
  const title = selectedNode?.name ?? (selectedTransition ? (selectedTransition.transition.label ?? 'Transition') : selectedIds.length > 1 ? `${selectedIds.length} nodes selected` : studio.document.integration.displayName)
  const tabs = selectedIds.length > 1 ? ['settings', 'contract', 'changes'] : ['settings', 'contract', 'last-run', 'changes', 'validation']
  return (
    <>
      <header className="inspector-header">
        <div><span className="eyebrow">{selectedNode ? KIND_LABEL[selectedNode.kind] : selectedTransition ? 'Transition' : selectedIds.length > 1 ? 'Selection' : 'Procedure'}</span><h2>{title}</h2></div>
        <IconButton label="Close inspector" onClick={close}><X size={16} /></IconButton>
        {selectedNode && <code>{selectedNode.id}</code>}
      </header>
      <div className="panel-tabs inspector-tabs" role="tablist" aria-label="Inspector sections">
        {tabs.map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value === 'last-run' ? 'Last Run' : value === 'changes' ? 'Agent Changes' : value[0].toUpperCase() + value.slice(1)}</button>)}
      </div>
      <div className="inspector-body">
        {tab === 'settings' && selectedNode && <NodeSettings node={selectedNode} method={studio.document.method} update={(updater, label) => updateNode(selectedNode.id, updater, label)} setSelectedEdge={setSelectedEdge} showError={showError} />}
        {tab === 'settings' && selectedTransition && <TransitionSettings value={selectedTransition} method={studio.document.method} mutate={mutate} setSelectedEdge={setSelectedEdge} showError={showError} />}
        {tab === 'settings' && selectedIds.length > 1 && <SelectionSettings ids={selectedIds} method={studio.document.method} />}
        {tab === 'settings' && !selectedNode && !selectedTransition && selectedIds.length < 2 && <ProcedureSettings studio={studio} mutate={mutate} />}
        {tab === 'contract' && selectedNode && <NodeContract node={selectedNode} method={studio.document.method} update={(updater, label) => updateNode(selectedNode.id, updater, label)} />}
        {tab === 'contract' && !selectedNode && <ContractEditor studio={studio} mutate={mutate} />}
        {tab === 'last-run' && <LastRun run={run} node={selectedNode} setSelectedIds={setSelectedIds} />}
        {tab === 'changes' && <AgentChanges studio={studio} selectedNode={selectedNode} proposalText={proposalText} setProposalText={setProposalText} loadProposal={loadProposal} selected={proposalSelection} setSelected={setProposalSelection} decide={decideProposal} />}
        {tab === 'validation' && <Validation diagnostics={studio.validation.diagnostics} reveal={revealDiagnostic} />}
      </div>
    </>
  )
}

function NodeSettings({ node, method, update, setSelectedEdge, showError }) {
  const [advanced, setAdvanced] = useState(false)
  const canonical = useMemo(() => JSON.stringify(node, null, 2), [node])
  const [source, setSource] = useState(canonical)
  const lastCanonical = useRef(canonical)
  useEffect(() => {
    if (canonical === lastCanonical.current) return
    lastCanonical.current = canonical
    setSource(canonical)
  }, [canonical])
  const commit = useCallback((key, value) => update((draft) => { draft[key] = value }, `Edit ${key}`), [update])
  const applySource = () => {
    let value
    try {
      value = JSON.parse(source)
    } catch (error) {
      showError({ code: 'INVALID_JSON', message: `Node source is not valid JSON: ${error.message}` })
      return
    }
    update((draft) => { for (const key of Object.keys(draft)) delete draft[key]; Object.assign(draft, value) }, 'Apply node source')
  }
  return (
    <div className="inspector-section-stack">
      <section><h3>Identity</h3><Field label="Name"><DebouncedInput value={node.name} onCommit={(value) => commit('name', value)} /></Field><div className="readonly-row"><span>Kind</span><b>{KIND_LABEL[node.kind] ?? node.kind}</b></div></section>
      {node.kind === 'agent-turn' && <section><h3>Agent step</h3><Field label="Role"><select value={node.role} onChange={(event) => commit('role', event.target.value)}>{method.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></Field><Field label="Workspace access"><select value={node.access} onChange={(event) => commit('access', event.target.value)}><option value="none">None</option><option value="read">Read</option><option value="write">Write</option></select></Field><Field label="Instruction"><DebouncedInput multiline rows={6} value={node.instruction} onCommit={(value) => commit('instruction', value)} /></Field></section>}
      {node.kind === 'human-input' && <section><h3>Human checkpoint</h3><Field label="Prompt"><DebouncedInput multiline rows={5} value={node.prompt} onCommit={(value) => commit('prompt', value)} /></Field><Field label="Interaction"><select value={node.interaction} onChange={(event) => commit('interaction', event.target.value)}><option value="input">Input</option><option value="checkpoint">Checkpoint</option></select></Field><Field label="Response artifact"><select value={node.responseArtifact} onChange={(event) => update((draft) => { draft.responseArtifact = event.target.value; draft.produces = [event.target.value] }, 'Change response artifact')}>{method.artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.name}</option>)}</select></Field></section>}
      {node.kind === 'procedure-call' && <section><h3>Exact subprocedure</h3><Field label="Procedure id"><DebouncedInput value={node.procedure.id} onCommit={(value) => update((draft) => { draft.procedure.id = value }, 'Edit subprocedure id')} /></Field><Field label="Exact version" hint="Version ranges are intentionally not accepted."><DebouncedInput value={node.procedure.version} onCommit={(value) => update((draft) => { draft.procedure.version = value }, 'Edit subprocedure version')} /></Field><div className="impact-callout"><History size={15} /><span>Version changes appear as semantic diffs with downstream node impact.</span></div></section>}
      {node.kind === 'direct-call' && <section><h3>Capability target</h3>{['providerId', 'capabilityId', 'capabilityVersion', 'operationId'].map((key) => <Field label={key.replace(/([A-Z])/gu, ' $1')} key={key}><DebouncedInput value={node.target[key]} onCommit={(value) => update((draft) => { draft.target[key] = value }, `Edit ${key}`)} /></Field>)}</section>}
      <section><div className="section-heading"><h3>Routes</h3><button className="button quiet small" type="button" disabled={node.transitions.length >= 12} onClick={() => update((draft) => {
        const consumed = draft.consumes[0]
        const path = consumed ? `${method.inputs.some((item) => item.id === consumed) ? 'inputs' : 'outputs'}.${consumed}` : 'outcome'
        const route = { id: nextTransitionId(method, node.id), when: { path, operator: 'exists' }, to: null, label: 'New route' }
        const fallback = draft.transitions.findIndex((item) => item.when.operator === 'always')
        draft.transitions.splice(fallback < 0 ? draft.transitions.length : fallback, 0, route)
      }, 'Add route')}><Plus size={13} />Route</button></div>{node.transitions.map((route, index) => <button className="route-card" type="button" key={route.id} onClick={() => setSelectedEdge(route.id)}><b>{route.label ?? `Route ${index + 1}`}</b><code>{route.when.operator === 'always' ? 'fallback' : `${route.when.path} ${route.when.operator}${Object.hasOwn(route.when, 'value') ? ` ${JSON.stringify(route.when.value)}` : ''}`}</code><span>→ {route.to ?? 'Complete'}</span></button>)}</section>
      <section><button className="section-toggle" type="button" onClick={() => setAdvanced(!advanced)}><Code2 size={14} />Advanced node source<ChevronDown size={14} className={advanced ? 'rotate' : ''} /></button>{advanced && <><textarea className="mini-code" value={source} onChange={(event) => setSource(event.target.value)} spellCheck="false" rows={15} /><button className="button quiet full" type="button" onClick={applySource}>Apply node source</button></>}</section>
    </div>
  )
}

function TransitionSettings({ value, method, mutate, setSelectedEdge, showError }) {
  const { node, index, transition } = value
  const canonical = useMemo(() => JSON.stringify(transition.when, null, 2), [transition.when])
  const [condition, setCondition] = useState(canonical)
  const [advanced, setAdvanced] = useState(false)
  const lastCanonical = useRef(canonical)
  useEffect(() => {
    if (canonical === lastCanonical.current) return
    lastCanonical.current = canonical
    setCondition(canonical)
  }, [canonical])
  const applyCondition = () => {
    let parsed
    try {
      parsed = JSON.parse(condition)
    } catch (error) {
      showError({ code: 'INVALID_JSON', message: `Condition is not valid JSON: ${error.message}` })
      return
    }
    mutate((draft) => { draft.document.method.graph.nodes.find((item) => item.id === node.id).transitions[index].when = parsed }, { label: 'Edit transition condition' })
  }
  const updateRoute = (updater, label) => mutate((draft) => {
    const route = draft.document.method.graph.nodes.find((item) => item.id === node.id).transitions[index]
    updater(route)
  }, { label })
  const changeOperator = (operator) => updateRoute((route) => {
    const path = route.when.path ?? (node.consumes[0] ? `${method.inputs.some((item) => item.id === node.consumes[0]) ? 'inputs' : 'outputs'}.${node.consumes[0]}` : 'outcome')
    if (operator === 'always') route.when = { operator: 'always' }
    else if (operator === 'exists') route.when = { path, operator }
    else if (operator === 'in') route.when = { path, operator, value: Array.isArray(route.when.value) ? route.when.value : [] }
    else route.when = { path, operator, value: Object.hasOwn(route.when, 'value') ? route.when.value : '' }
  }, 'Change route operator')
  const changeValue = (text) => {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      showError({ code: 'INVALID_JSON_VALUE', message: `Route value is not valid JSON: ${error.message}` })
      return
    }
    updateRoute((route) => { route.when.value = parsed }, 'Change route value')
  }
  const move = (offset) => {
    mutate((draft) => {
      const routes = draft.document.method.graph.nodes.find((item) => item.id === node.id).transitions
      const target = index + offset
      ;[routes[index], routes[target]] = [routes[target], routes[index]]
    }, { label: 'Reorder routes' })
    setSelectedEdge(transition.id)
  }
  const fallbackIndex = node.transitions.findIndex((item) => item.when.operator === 'always')
  const canMoveDown = index < node.transitions.length - 1 && !(fallbackIndex >= 0 && index + 1 === fallbackIndex)
  return <div className="inspector-section-stack"><section><h3>Route</h3><Field label="Label"><DebouncedInput value={transition.label ?? ''} onCommit={(text) => updateRoute((route) => { if (text) route.label = text; else delete route.label }, 'Edit transition label')} /></Field><Field label="Target"><select value={transition.to ?? ''} onChange={(event) => updateRoute((route) => { route.to = event.target.value || null }, 'Reroute transition')}><option value="">Complete Procedure</option>{method.graph.nodes.filter((item) => item.id !== node.id).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><Field label="Operator"><select value={transition.when.operator} onChange={(event) => changeOperator(event.target.value)}><option value="always">Always (fallback)</option><option value="equals">Equals</option><option value="not_equals">Does not equal</option><option value="exists">Exists</option><option value="in">Is in list</option></select></Field>{transition.when.operator !== 'always' && <Field label="Value path"><DebouncedInput value={transition.when.path ?? ''} placeholder="inputs.topic" onCommit={(path) => updateRoute((route) => { route.when.path = path }, 'Change route path')} /></Field>}{!['always', 'exists'].includes(transition.when.operator) && <Field label="Comparison value" hint="Use JSON so booleans, numbers, arrays, and strings keep their type."><DebouncedInput value={JSON.stringify(transition.when.value)} onCommit={changeValue} /></Field>}<div className="route-actions"><button className="button quiet small" type="button" disabled={index === 0 || transition.when.operator === 'always'} onClick={() => move(-1)}>Move up</button><button className="button quiet small" type="button" disabled={!canMoveDown} onClick={() => move(1)}>Move down</button></div><button className="section-toggle" type="button" onClick={() => setAdvanced(!advanced)}><Code2 size={14} />Advanced condition source<ChevronDown size={14} className={advanced ? 'rotate' : ''} /></button>{advanced && <><textarea className="mini-code" rows={7} value={condition} onChange={(event) => setCondition(event.target.value)} /><button className="button quiet full" type="button" onClick={applyCondition}>Apply condition source</button></>}<button className="danger-button full" type="button" onClick={() => { mutate((draft) => { const routes = draft.document.method.graph.nodes.find((item) => item.id === node.id).transitions; if (routes.length > 1) routes.splice(index, 1); else routes[0].to = null }, { label: 'Remove transition' }); setSelectedEdge(null) }}><Trash2 size={14} />Remove connection</button></section></div>
}

function SelectionSettings({ ids, method }) {
  const nodes = method.graph.nodes.filter((node) => ids.includes(node.id))
  return <div className="inspector-section-stack"><section><h3>Selection</h3><p className="support-copy">Graph operations apply to these {nodes.length} canonical nodes.</p>{nodes.map((node) => <div className="selection-row" key={node.id}><span className="node-icon">{React.createElement(NODE_ICONS[node.kind], { size: 14 })}</span><span><b>{node.name}</b><small>{node.id}</small></span></div>)}</section></div>
}

function ProcedureSettings({ studio, mutate }) {
  const integration = studio.document.integration
  const method = studio.document.method
  return <div className="inspector-section-stack"><section><h3>Procedure identity</h3><Field label="Display name"><DebouncedInput value={integration.displayName} onCommit={(value) => mutate((draft) => { draft.document.integration.displayName = value }, { label: 'Edit display name' })} /></Field><Field label="Procedure id"><DebouncedInput value={integration.procedure.id} onCommit={(value) => mutate((draft) => { draft.document.integration.procedure.id = value }, { label: 'Edit Procedure id' })} /></Field><Field label="Summary"><DebouncedInput multiline rows={5} value={integration.summary} onCommit={(value) => mutate((draft) => { draft.document.integration.summary = value }, { label: 'Edit summary' })} /></Field><Field label="Version"><DebouncedInput value={integration.procedure.version} onCommit={(value) => mutate((draft) => { draft.document.integration.procedure.version = value }, { label: 'Edit Procedure version' })} /></Field><div className="readonly-row"><span>Package component</span><b>{studio.project.componentId}</b></div></section><section><h3>Method identity</h3><Field label="Name"><DebouncedInput value={method.name} onCommit={(value) => mutate((draft) => { draft.document.method.name = value }, { label: 'Edit Method name' })} /></Field><Field label="Description"><DebouncedInput multiline rows={5} value={method.description} onCommit={(value) => mutate((draft) => { draft.document.method.description = value }, { label: 'Edit Method description' })} /></Field><Field label="Revision"><DebouncedInput type="number" min="1" max="1000000" value={method.revision} onCommit={(value) => mutate((draft) => { draft.document.method.revision = Number(value) }, { label: 'Edit Method revision' })} /></Field></section><section><h3>Lifecycle</h3><div className="metric-grid"><div><span>Mode</span><b>{integration.procedure.lifecycle.mode}</b></div><div><span>Resume</span><b>{integration.procedure.lifecycle.resumable ? 'Yes' : 'No'}</b></div><div><span>Interaction</span><b>{integration.procedure.lifecycle.interaction}</b></div></div></section></div>
}

function ToggleList({ title, values, selected, onChange }) {
  return <section><h3>{title}</h3><div className="check-list">{values.map((item) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => onChange(item.id, event.target.checked)} /><span><b>{item.name}</b><small>{item.id}</small></span></label>)}</div></section>
}

function NodeContract({ node, method, update }) {
  const toggle = (field, id, checked) => update((draft) => {
    draft[field] = checked ? [...new Set([...draft[field], id])] : draft[field].filter((value) => value !== id)
    if (field === 'produces' && ['direct-call', 'procedure-call', 'transform'].includes(draft.kind)) {
      draft.output ??= {}
      if (checked) draft.output[id] ??= { literal: '' }
      else delete draft.output[id]
    }
  }, `Change ${field}`)
  return <div className="inspector-section-stack"><ToggleList title="Consumes" values={[...method.inputs, ...method.artifacts]} selected={node.consumes} onChange={(id, checked) => toggle('consumes', id, checked)} />{node.kind !== 'condition' && node.kind !== 'human-input' && <ToggleList title="Produces" values={method.artifacts} selected={node.produces} onChange={(id, checked) => toggle('produces', id, checked)} />}<ToggleList title="Permissions" values={method.permissions} selected={node.permissions} onChange={(id, checked) => toggle('permissions', id, checked)} /><ToggleList title="Resources" values={method.resources} selected={node.resources} onChange={(id, checked) => toggle('resources', id, checked)} /><section><h3>Visible relationship</h3><div className="relation-map"><div><span>Inputs</span><TagList values={node.consumes} /></div><div className="relation-arrow">→</div><div><span>Outputs</span><TagList values={node.produces} /></div></div></section></div>
}

function LastRun({ run, node, setSelectedIds }) {
  if (!run) return <div className="empty-state tall"><History size={24} /><b>No Test Run selected</b><span>Start or select a Run to bind trace evidence to source objects.</span></div>
  const attempts = node ? run.attempts.filter((item) => item.stage === node.id) : run.attempts
  return <div className="inspector-section-stack"><section><h3>Run identity</h3><code className="block-code">{run.runId}</code><div className="readonly-row"><span>Source</span><b>{run.sourceDigest.slice(7, 19)}</b></div><div className="readonly-row"><span>Status</span><b className={`status-text ${run.status}`}>{STATUS_LABEL[run.status] ?? run.status}</b></div></section><section><h3>{node ? `${node.name} attempts` : 'Attempts'}</h3>{attempts.length ? attempts.map((attempt) => <button className="attempt-row" type="button" key={attempt.id} onClick={() => setSelectedIds([attempt.stage])}><span className={`attempt-dot ${attempt.status}`} /><span><b>{attempt.stage}</b><small>{attempt.kind ?? 'agent-turn'} · {attempt.status}</small></span></button>) : <p className="empty-state">No attempt has reached this object.</p>}</section></div>
}

function AgentChanges({ studio, selectedNode, proposalText, setProposalText, loadProposal, selected, setSelected, decide }) {
  const proposal = studio.proposal
  const recoveredDraft = proposal?.source === 'recovered-draft'
  const changes = proposal?.changes.filter((item) => !studio.proposalDecisions[item.id] && (!selectedNode || !item.affectedNodeIds?.length || item.affectedNodeIds.includes(selectedNode.id))) ?? []
  return <div className="inspector-section-stack"><section><h3>{recoveredDraft ? 'Recovered draft changes' : 'Agent source proposal'}</h3><p className="support-copy">{recoveredDraft ? 'Disk source is open. Review the preserved private draft as semantic changes; nothing is reapplied silently.' : 'Load one complete canonical source bundle. Chat claims are not accepted as changes.'}</p><textarea rows={6} className="mini-code" aria-label="Agent proposal JSON" placeholder="Paste integration, method, inputSchema, and outputSchema…" value={proposalText} onChange={(event) => setProposalText(event.target.value)} /><label className="file-button"><Download size={14} />Choose JSON<input type="file" accept="application/json,.json" onChange={async (event) => { const file = event.target.files[0]; if (file) setProposalText(await file.text()) }} /></label><button className="button primary full" type="button" disabled={!proposalText.trim()} onClick={loadProposal}><Sparkles size={14} />Review semantic diff</button></section>{proposal && <section><div className="section-heading"><h3>Proposed changes</h3><span>{changes.length}</span></div>{proposal.candidateValidation.valid ? <p className="inline-status good"><Check size={13} />Candidate validates as a complete source bundle</p> : <p className="inline-status bad"><CircleAlert size={13} />Candidate has {proposal.candidateValidation.diagnostics.length} validation issues</p>}<div className="change-list">{changes.map((change) => { const summary = proposalSummary(change); return <label className="change-card" key={change.id}><input type="checkbox" checked={selected.has(change.id)} onChange={(event) => { const next = new Set(selected); if (event.target.checked) next.add(change.id); else next.delete(change.id); setSelected(next) }} /><span><b>{change.label}</b><small>{change.kind}</small><span className="diff-line"><del>{summary.before.slice(0, 90)}</del><ins>{summary.after.slice(0, 90)}</ins></span>{change.impact?.length ? <em>Downstream: {change.impact.join(', ')}</em> : null}</span></label>})}</div>{changes.length > 0 && <div className="decision-actions"><button className="button quiet" type="button" disabled={!selected.size} onClick={() => decide('reject')}><X size={14} />Reject</button><button className="button primary" type="button" disabled={!selected.size} onClick={() => decide('accept')}><Check size={14} />Accept selected</button></div>}</section>}</div>
}

function Validation({ diagnostics, reveal }) {
  if (!diagnostics.length) return <div className="empty-state tall success"><ShieldCheck size={28} /><b>Continuous validation passed</b><span>Schema, graph semantics, product contract, and execution binding agree.</span></div>
  return <div className="diagnostic-list">{diagnostics.map((item) => <button type="button" key={item.id} onClick={() => reveal(item)}><CircleAlert size={15} /><span><b>{item.code}</b><small>{item.message}</small></span>{item.target?.id ? <em>{item.target.id}</em> : <em>{item.source}</em>}</button>)}</div>
}

function RunPanel({ studio, runs, selectedRunId, setSelectedRunId, run, tab, setTab, scenarioId, setScenarioId, scenarioDraft, setScenarioDraft, scenarioDirty, saveScenarioDraft, scenarioName, setScenarioName, saveScenario, duplicateScenario, startRun, action, replay, selectedNodeId, selectNode, close, expanded, setExpanded }) {
  const [answer, setAnswer] = useState('')
  const [input, setInput] = useState('')
  const active = run && ['running', 'ready'].includes(run.status)
  const hasErrors = Boolean(run?.problem) || Boolean(run?.attempts?.some((item) => item.error))
  useEffect(() => { setAnswer('') }, [run?.question?.id, selectedRunId])
  const runLabel = (item) => `${STATUS_LABEL[item.status] ?? item.status} · ${item.goal}${item.replayOf ? ' · replay' : ''} · ${new Date(item.updatedAt).toLocaleTimeString()}`
  return <section className={`run-panel ${expanded ? 'expanded' : ''}`}>
    <header className="run-header">
      <div className="run-title"><Play size={15} /><b>Test Run</b><select aria-label="Test scenario" value={scenarioId ?? ''} onChange={(event) => setScenarioId(event.target.value)}>{studio.scenarios.map((scenario) => <option value={scenario.id} key={scenario.id}>{scenario.name}</option>)}</select><button className="button primary small" type="button" onClick={startRun}><Play size={13} />{scenarioDirty ? 'Save & Run' : 'Run'}</button></div>
      <div className="run-picker">{runs.length > 0 && <select aria-label="Run history" value={selectedRunId ?? ''} onChange={(event) => setSelectedRunId(event.target.value)}><option value="">Select Run…</option>{runs.map((item) => <option value={item.id} key={item.id}>{runLabel(item)}</option>)}</select>}{run && <span className={`run-status ${run.status}`}><span />{STATUS_LABEL[run.status] ?? run.status}</span>}<IconButton label={expanded ? 'Restore Test Run panel' : 'Expand Test Run workspace'} onClick={() => setExpanded(!expanded)}>{expanded ? <PanelBottomOpen size={16} /> : <Maximize2 size={16} />}</IconButton><IconButton label="Close Test Run panel" onClick={close}><PanelBottomClose size={16} /></IconButton></div>
    </header>
    <div className="run-content">
      <nav className="run-tabs" role="tablist" aria-label="Test Run sections">{['input', 'timeline', 'state', 'artifacts', 'errors'].map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value[0].toUpperCase() + value.slice(1)}{value === 'errors' && hasErrors ? <span className="tab-alert" /> : null}</button>)}</nav>
      <div className="run-view">
        {tab === 'input' && <ScenarioEditor studio={studio} scenario={scenarioDraft} dirty={scenarioDirty} onChange={setScenarioDraft} onSave={saveScenarioDraft} run={run} cloneName={scenarioName} setCloneName={setScenarioName} cloneRun={saveScenario} cloneScenario={duplicateScenario} />}
        {tab !== 'input' && !run && <div className="run-empty"><Play size={22} /><b>Run the selected scenario against the current source</b><span>Runs capture exact Procedure, source fingerprint, request bounds, node state, and artifacts.</span></div>}
        {run && tab === 'timeline' && <Timeline run={run} selectNode={selectNode} showState={() => setTab('state')} />}
        {run && tab === 'state' && <div className="state-view"><div className="state-metrics"><div><span>Phase</span><b>{run.phase}</b></div><div><span>Nodes</span><b>{run.attempts.length} attempts</b></div><div><span>Elapsed</span><b>{run.elapsedMs} ms</b></div><div><span>Source</span><b>{run.sourceDigest.slice(7, 19)}</b></div></div>{run.question && <div className="question-card"><UserRound size={17} /><div><b>{run.question.text}</b>{run.question.options?.length ? <select value={answer} onChange={(event) => setAnswer(event.target.value)}><option value="">Choose…</option>{run.question.options.map((option) => <option key={option}>{option}</option>)}</select> : <input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Answer and continue" />}</div><button className="button primary" type="button" disabled={!answer} onClick={() => { action({ action: 'answer', questionId: run.question.id, value: answer }); setAnswer('') }}>Continue</button></div>}<div className="run-actions">{['paused', 'failed'].includes(run.status) && !run.question && <button className="button primary" type="button" onClick={() => action({ action: 'resume' })}><Play size={14} />Resume</button>}{active && <button className="button quiet" type="button" onClick={() => action({ action: 'pause' })}><Pause size={14} />Pause</button>}{!['complete', 'cancelled', 'reconciling'].includes(run.status) && <button className="danger-button" type="button" onClick={() => action({ action: 'cancel' })}><Square size={13} />Cancel</button>}{selectedNodeId && !active && <button className="button quiet" type="button" onClick={() => replay(selectedNodeId)}><RotateCcw size={14} />Replay from {selectedNodeId}</button>}</div>{!['complete', 'cancelled'].includes(run.status) && <div className="instruction-row"><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Add durable Run input…" /><button className="button quiet" type="button" disabled={!input} onClick={() => { action({ action: 'input', text: input, scope: 'task' }); setInput('') }}>Add input</button></div>}</div>}
        {run && tab === 'artifacts' && <Artifacts outputs={run.outputs} />}
        {run && tab === 'errors' && <Errors run={run} />}
      </div>
    </div>
  </section>
}

function Timeline({ run, selectNode, showState }) {
  const rows = run.attempts.length ? run.attempts : [{ id: 'created', stage: run.phase, kind: 'run', status: run.status, startedAt: run.createdAt }]
  return <div className="timeline">{rows.map((item, index) => <button className="timeline-row" type="button" onClick={() => item.stage && selectNode(item.stage)} key={item.id}><span className={`timeline-marker ${item.status}`}><span /></span><span className="timeline-index">{String(index + 1).padStart(2, '0')}</span><span><b>{item.stage}</b><small>{item.kind ?? 'node'} · {item.startedAt ? new Date(item.startedAt).toLocaleTimeString() : ''}</small></span><em>{item.status}</em></button>)}{run.question && <button className="timeline-row waiting" type="button" onClick={showState}><span className="timeline-marker waiting"><span /></span><span className="timeline-index">··</span><span><b>Human checkpoint</b><small>{run.question.text}</small></span><em>waiting · answer</em></button>}</div>
}

function Artifacts({ outputs }) {
  const entries = Object.entries(outputs)
  if (!entries.length) return <div className="run-empty"><Box size={22} /><b>No artifacts yet</b><span>Declared values appear here when producing nodes complete.</span></div>
  return <div className="artifact-grid">{entries.map(([id, output]) => <article key={id}><header><Box size={14} /><b>{id}</b><span>{output.stage}</span></header><pre>{JSON.stringify(output.value, null, 2)}</pre><footer>{output.artifact.slice(0, 12)} · {new Date(output.updatedAt).toLocaleTimeString()}</footer></article>)}</div>
}

function Errors({ run }) {
  const failed = run.attempts.filter((item) => item.error)
  if (!run.problem && !failed.length) return <div className="run-empty success"><ShieldCheck size={23} /><b>No run errors</b><span>Provider events and node attempts remain in Timeline.</span></div>
  return <div className="error-stack">{run.problem && <article><CircleAlert size={16} /><div><b>{run.problem.code}</b><p>{run.problem.message}</p>{run.problem.details && <pre>{JSON.stringify(run.problem.details, null, 2)}</pre>}</div></article>}{failed.map((item) => <article key={item.id}><XCircle size={16} /><div><b>{item.stage}</b><p>{item.error.message}</p></div></article>)}</div>
}

function Modal({ children, onClose, returnFocus }) {
  const dialog = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useLayoutEffect(() => {
    const previous = returnFocus ?? document.activeElement
    const key = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialog.current) return
      const focusable = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
      if (!focusable.length) {
        event.preventDefault()
        dialog.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', key)
    const first = dialog.current?.querySelector('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')
    if (first) first.focus()
    else dialog.current?.focus()
    return () => {
      window.removeEventListener('keydown', key)
      previous?.focus?.()
    }
  }, [])
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div ref={dialog} className="modal" role="dialog" aria-modal="true" aria-label="Procedure Studio dialog" tabIndex={-1}><IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>{children}</div></div>
}

function SourceConflictRecovery({ reconcile, reload, busy }) {
  return <div className="conflict-recovery"><span className="result-icon danger"><CircleAlert size={28} /></span><span className="eyebrow">External source change</span><h2>Preserve the draft before moving on</h2><p>Canonical files changed outside Studio. Saving is blocked so the private draft cannot overwrite them.</p><div className="recovery-choice recommended"><Sparkles size={18} /><div><b>Review draft against disk</b><span>Open the latest files and turn the private draft into semantic changes. Accept or reject nodes, edges, contracts, permissions, schemas, and versions individually.</span></div></div><div className="recovery-actions"><button className="button quiet" type="button" disabled={busy} onClick={reload}><RefreshCw size={14} />Discard draft and reload</button><button className="button primary" type="button" disabled={busy} onClick={reconcile}><GitBranch size={14} />Preserve and review</button></div></div>
}

function CopyFactButton({ value, label }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setDone(true)
      setTimeout(() => setDone(false), 1600)
    } catch {
      setDone(false)
    }
  }
  return <IconButton label={`Copy ${label}`} onClick={copy}>{done ? <Check size={13} /> : <Copy size={13} />}</IconButton>
}

function PackageResult({ result }) {
  return <div className="package-result"><span className="result-icon"><PackageCheck size={28} /></span><span className="eyebrow">Install candidate ready</span><h2>Package passed Host preview</h2><p>The sealed archive, descriptor inventory, Procedure product contract, and execution binding were checked without changing formal Agent Host state.</p><div className="package-facts"><div><span>Artifact</span><code>{result.artifact.path}</code><CopyFactButton value={result.artifact.path} label="artifact path" /></div><div><span>SHA-256</span><code>{result.artifact.sha256}</code><CopyFactButton value={result.artifact.sha256} label="SHA-256" /></div><div><span>Size</span><b>{result.artifact.bytes.toLocaleString()} bytes</b></div><div><span>Host health</span><b className="good-text">{result.preview.health.status}</b></div></div><div className="effect-strip"><ShieldCheck size={17} /><span><b>Boundary preserved</b> Formal install unchanged · not published · not deployed</span></div></div>
}

function ShortcutGuide() {
  const shortcuts = [
    ['⌘ S', 'Save canonical source'],
    ['⌘ ↵', 'Run selected scenario'],
    ['⌘ Z', 'Undo graph or contract edit'],
    ['⇧ ⌘ Z', 'Redo edit'],
    ['⌘ C / ⌘ V', 'Copy and paste selected nodes'],
    ['Delete', 'Remove selected nodes or connection'],
    ['Arrows', 'Nudge selection (⇧ for fine steps)'],
    ['G / S', 'Switch Graph and Source workspaces'],
    ['Esc', 'Close dialogs'],
  ]
  return <div className="shortcut-guide"><span className="result-icon"><Keyboard size={27} /></span><span className="eyebrow">Command reference</span><h2>Stay on the working object</h2><p>These shortcuts have visible toolbar equivalents; the interface does not depend on memorization.</p><div>{shortcuts.map(([keys, label]) => <section key={keys}><kbd>{keys}</kbd><span>{label}</span></section>)}</div></div>
}

export function App() {
  return <ReactFlowProvider><AppShell /></ReactFlowProvider>
}
