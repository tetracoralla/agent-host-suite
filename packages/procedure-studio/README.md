# Procedure Studio

Procedure Studio is the local developer product for authoring, validating,
testing, reviewing, and packaging one Procedure product. It is separate from
Agent Host Manager and from the headless consumer Runner.

The graphical canvas, source view, Agent proposals, validation, Test Runs, and
package export all operate on the same `openadam.method-graph.v2` Method plus the
existing Procedure integration and input/output schemas. Node positions,
selection, viewport, panel sizes, and unsaved recovery live in a private Studio
state root; they are not a second Procedure graph format.

## Start

```sh
npm run studio -- serve
```

Without `--project` the Studio opens on its home surface: create a Procedure
from one of the bundled templates (blank, research-and-verify,
develop-and-review, capability-orchestration, human-decision), open a recent
project, or type any project directory. The home button in the activity rail
returns there, and recent projects are remembered per state root.

```sh
npm run studio -- serve --project packages/procedure-studio/examples/research-brief
```

The command prints a private loopback URL. It does not install a component,
change an Agent app, or start the consumer Manager. Use `--state-root PATH` for
isolated draft and Test Run state and `--no-open` to avoid launching a browser.

The source project contains:

- `studio.project.json`: Studio-only packaging and scenario locations;
- `procedure.integration.json`: the existing Procedure product contract;
- `method.json`: the canonical Method Graph v2 source;
- `input.schema.json` and `output.schema.json`;
- `scenarios/*.json`: saved developer Test Run inputs and bounds; and
- legal files required by the existing Host component archive contract.

## Workspace

The default view leaves the graph canvas open rather than reserving permanent
columns for every tool. Use the semantic activity rail to slide out the object
library or structure tree, and the settings button to open the contextual
inspector. Settings, contract relationships, the selected Run, Agent changes,
and validation stay attached to the selected source object. The Test Run tray
is collapsed until needed and can expand into a near-full debugging workspace.

The Procedure contract inspector edits inputs, artifacts, declared outputs,
Agent roles, role independence and provider defaults, permissions, and
workspace/file/account resources as first-class objects. Schema types and
product permission/resource declarations stay in sync with the Method instead
of requiring a parallel JSON-only workflow. Referenced objects expose graph and
scenario consumers and cannot be deleted until those relationships are removed.

The graph supports drag/drop or click-to-add objects, port connections,
selection rectangles, multi-select, copy/paste, delete, alignment,
distribution, deterministic auto-arrangement, pan/zoom, a minimap, and persisted
viewport and selection. Method Graph remains the source of truth; its stable
transition ids adapt into Graph View Compiler relations. Graph View Compiler
owns deterministic layout, boundary ports, orthogonal routes, change identity,
and geometry diagnostics, while React Flow owns direct manipulation, selection,
camera, and rendering. Manual positions remain product-authored and are routed
through the compiler's fixed-position profile rather than becoming a second
graph model. `G`
and `S` switch graph and canonical JSON source views. The command-reference
modal lists the remaining keyboard equivalents.

Continuous validation points diagnostics back to graph objects and unknown
source fields fail closed. If canonical files change outside Studio, Save is
blocked. **Preserve and review** opens the latest disk source and converts the
private draft into semantic changes so nodes, edges, contracts, permissions,
schemas, and versions can be accepted or rejected without silently overwriting
either side.

Test scenarios execute through the existing Procedure Coordinator. The tray
shows the exact request, binding, node timeline, durable state, artifacts, and
errors; human-input Runs can continue or cancel, failed Runs can resume, and a
stopped Run can be replayed from a safe node as a new Run while the original
evidence remains available. The Input tab edits reusable typed inputs, grants,
resource bindings, Agent bindings (including native ZCode model coordinates and
optional resumable sessions), and execution limits before a Run. Runnable-input
problems and intentionally missing authority are distinguished in place; **Save
& Run** persists valid source scenario bytes before execution. The current
editable request or a selected Run's immutable request can be cloned as a
separate scenario so both authored variants and representative reproductions
outlive a Run. External scenario changes are reloaded explicitly instead of
being overwritten by a stale draft.

`Package` saves and validates the current source, creates a sealed Agent Host
component archive, and runs the existing standalone Host preview admission path.
It does not publish, deploy, or touch the formal installed environment.
