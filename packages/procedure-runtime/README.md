# Procedure Runner (`procedure-runtime` package)

Optional local work-method coordination inside Agent Host Suite. A developer
produces and validates a versioned Procedure product. At use time, a person's
Agent selects an installed version, maps the person's task into its declared
inputs, starts the Run and consumes its structured outputs. The person does not
assemble stages or roles for each task.

The Runner is headless. Its consumer is the person's Agent, not the person and
not a workflow authoring form. Human environment management belongs to Agent
Host Manager, which may show whether a Procedure product is installed and
available to Agents but does not expose Run stages, logs, bindings or internal
coordination. Procedure authoring belongs to a separate developer product.

The core Method/Run source is the closed, versioned
`openadam.method-graph.v2` contract. It owns typed inputs, artifacts and
resources; explicit consumption/production; ordered routes; permissions; and
optional Agent roles. Nodes can be `agent-turn`, `direct-call`,
`procedure-call`, `human-input`, `condition` or `transform`. Unknown fields are
rejected. `parallel` and `wait` are declared versioned extension points with
`supported: false`, not simulated through Agent instructions.

Three structurally different definitions remain as executable development
references. They are not automatically registered as installed products:

- **Development and independent review** is the deep Git profile. Its profile
  validator owns planning, writer, independent-review and final-owner rules,
  candidate identity, staging and commit separation.
- **Research brief** uses researcher, fact-checker and editor roles, typed notes
  and brief artifacts, a coverage-driven rework condition, and no workspace.
- **Workspace composition** binds a Git workspace, prepares an artifact in an
  Agent turn, calls a Direct Capability, and invokes one exact subprocedure with
  explicit child grants and resource mappings.

This is still a **local implementation**, not a claim of qualified multi-shell
production support. The non-development method is an offline anti-hardcoding
and interaction reference; its provider-native network behavior has not been
qualified. Native model/tool execution and existing-desktop-session control
require provider-specific runtime verification. Protocol handshakes and offline
fixtures are not that evidence. This package also does not claim conformance to
the separate portable Procedure standards.

## Start locally

From the Suite checkout, with Node 22.16 or later (and Git when running the
development profile):

```sh
npm run procedure -- serve
```

The command prints a private loopback origin and Bearer token for the calling
Agent integration. Keep both private and keep the coordinator terminal running.
Restarting the coordinator retains tasks but requires
reconciliation of interrupted workers; it never blindly reissues work.

Use `--state-root PATH` for a separate private store or `--port PORT` for a
stable local address. Do not put the state directory inside source that will
be committed. State contains task content and attributed Agent reports, not
Provider credentials. No service or plugin is installed by this command.

```sh
npm run procedure -- probe --workspace /path/to/checkout
npm run check:procedure-runtime
```

`probe` negotiates protocols through the same enclosed launcher as tasks,
without running a model. It does not prove session credentials, model selection
or tool execution. The automated suite exercises a synchronous Direct
Procedure, a no-workspace research Run with question/continuation, and a
workspace-backed Agent/Direct/subprocedure composition. It also launches the
packaged operations Skill in separate processes through
list/describe/invoke/status/continue. These fixtures do not prove real Provider
behavior.

## Consumer use

Host installed state is the Procedure catalog authority. The normal Agent route
is the packaged Host interface:

1. `agent-host procedure list --query TEXT --limit N --budget-bytes N --json`
   returns compact exact-version summaries without schemas. Follow
   `page.nextCursor` when needed.
2. `agent-host procedure describe --id ID --version VERSION --json` returns the
   one full contract: schemas, declared permissions, installed permission
   ceiling, resources, execution binding, invocation descriptor and Run Request
   defaults.
3. The Agent builds one `openadam.agent-host-procedure-run-request.v0.1` object
   with that exact identity, schema-valid `inputs`, explicit task `grants`,
   required `resources`, bounded `limits` and an idempotency key, then pipes it
   to `agent-host procedure invoke --request - --json`. Direct products execute
   through Direct Runtime; agentic products load their contained Method into
   this Runner. Retrying the exact request is idempotent; concurrent retries
   share one durable result, and changing content under the same key is rejected
   before another Provider call. Direct result identity includes the current
   Procedure, Runtime and binding fingerprints, so a changed execution
   environment must be exercised again before it can become verified.
4. A completed result contains only the product's declared `outputs`. A
   stateful result may instead contain a `taskId`, structured interaction or
   error. `procedure status --run TASK_ID --json` reads durable state;
   `procedure continue --run TASK_ID --input - --json` accepts a bounded
   `answer`, `input`, `resume` or `cancel` action.

The packaged Host CLI owns Method-level questions and paused-run continuation.
Provider-native permission exchange while a worker turn is still active needs a
persistent Runner embedding or authenticated HTTP client; an ephemeral CLI
process does not claim that live transport boundary.

A product permission declaration is only a possible need. Installed state
stores a separate permission ceiling; the Run grants must fit both. A Provider
one-time request is surfaced only when its required grant already exists on the
Run and active node, so a callback cannot enlarge authority. Workspace, file
and account bindings are validated separately. The current Direct Runtime
work-order exposes neither per-node grants nor resource bindings, so a top-level
Direct Procedure requires every declared permission as an explicit Run grant
and admission rejects Direct Procedure resource declarations. Agentic Methods
retain path-specific grants and resource bindings.

An embedding application may use the authenticated HTTP server instead, but it
must inject the same validated installed product set into the Coordinator.
`GET /api/procedures` never reads a second Runner-owned catalog and a bare
Coordinator starts with no registered Procedure products. `POST /api/tasks`
accepts the same formal Run Request as Host invocation and cannot supply or
replace the selected product's Method. No human page or open Manager window
participates in execution.

The Runner records every artifact with its producing stage, attempt and consumed
artifact identities. Changing an upstream artifact invalidates derived outputs.
Completion requires every artifact marked required. Reports retain their source;
Agent-reported checks are not independent attestations. The development profile
additionally returns the latest candidate to the
   original Owner. Changed candidate bytes or requirements invalidate prior
   review evidence even when the changing attempt fails or is interrupted.
   Unresolved findings block completion, and independent review must match the
   current candidate before Owner completion can advance.
If automatic staging was not selected, the calling Agent can explicitly
   request staging of the named candidate later, or submit the reviewed
   candidate with a commit message under the user's authority. No push, release,
   deployment or live-install command exists in this coordinator. Git commit
   construction uses saved candidate bytes and a temporary, locked index,
   preserving unrelated staged work. Staging also uses saved bytes, not a
   second read of changing working files. Recovery
   refuses to overwrite newly staged candidate-path edits. It does not execute Git
   commit hooks or sign commits; repositories requiring those policies should
   use their normal reviewed commit workflow instead.

Procedure development is a separate source and packaging concern. The graphical
Procedure Studio in `packages/procedure-studio` owns structure, validation,
test Runs and package/export. This Runner package does not implement that
interface. Studio reads and writes the same Method Graph v2 source; it does
not keep a second graph format. The consumer HTTP API exposes installed
definitions read-only and does not open a Studio project.
Changing a Procedure requires a new validated product version; prior Runs keep
the identity, Method and declared-output snapshot with which they started.

The schema is intentionally bounded rather than a universal DSL: conditions use
`equals`, `not_equals`, `in` or `exists`; deterministic transforms use a bounded
path/literal/object/array expression tree; the current workspace adapter is
`git`; subprocedure calls require exact identities. Subprocedures that suspend
fail with `SUBPROCEDURE_WAIT_REQUIRED` until the declared wait extension is
implemented. Add another adapter as an explicit state/effect boundary instead
of treating Git snapshots as every domain's world model.

## Support and enforcement boundaries

| Boundary | Implementation |
| --- | --- |
| Codex | Public app-server stdio, exact thread start/resume, turn start/steer/interrupt, native permission requests; selected model inherited unless explicitly bound. Enclosed turns declare the supported `externalSandbox` policy, avoiding nested macOS sandbox initialization |
| Grok Build | ACP initialize/authenticate/new/load/prompt/cancel; `--no-leader` owns an isolated process, not the shared TUI leader; supplements use stop/continue. The coordinator supplies one kernel sandbox instead of nesting Grok's startup sandbox |
| ZCode | CLI-declared app-server stdio with session create/resume/send/subscribe/read/stop; version-sensitive protocol. Model selection or desktop-owned credential callbacks can be unavailable to an independent process; fail explicitly instead of substituting an API model |
| Already-running desktop sessions | Shared-control takeover is not implemented. Existing persisted sessions can be requested, but exclusive native ownership and full continuity remain a qualification gap |
| Local worker writes | macOS inherited Seatbelt rules protect actual Git metadata, the coordinator store, pre-existing protected paths and read-only review workspaces, including shell descendants. Codex/Grok writes are additionally confined to the checkout, temporary storage and their own harness persistence; global config/hooks are protected. Native tool approval protocols remain enabled |
| Other effects | Provider-native tool approvals are distinct. This package does **not** claim a complete network/MCP external-effect firewall. In particular, filesystem protection is not proof that a remote push or an external service write is impossible |
| Windows/Linux | State and protocol modules are portable; equivalent worker confinement is not implemented, so worker execution fails closed there |
| Git scope | Existing checkouts, staged/unstaged/untracked paths and symlinks; submodule snapshots require another binding and are rejected. Snapshot and changed-content budgets fail explicitly |
| Recovery | No automatically replayed uncertain model turn or commit; check worker process-group exit and current content. A recorded commit retains the checkout lease until index reconciliation finishes without creating another commit |

User questions preserve each Shell's native answer contract; they are not
rendered as tool-approval buttons. Input delivery records distinguish saved,
awaiting receipt, native acknowledgement/result, and Agent-reported application.
The last is attributed evidence, not a semantic guarantee.

Each attempt gets one read-only role-specific context file. It includes the
dirty baseline, exact candidate path identities and effective user decisions;
large projections explicitly direct the worker to that file instead of silently
dropping requirements. The enclosing process cannot read other tasks or the
coordinator database. Temporary context files are removed only after confirmed
worker shutdown; durable source-attributed records remain in the task store.
Worker events have a 20,000-event / 32 MiB bound, including referenced payloads;
reaching it stops new execution. Control/recovery observations retain the latest
2,000 records with an explicit discarded count, so log saturation cannot prevent
pause or recovery.

Provider persistence remains writable for the real harness to record sessions;
it is not a separate per-task operating-system identity. Global configuration,
credential/config files and hook sources are not granted as task write targets.
Custom or managed provider restrictions can still prevent launch; failure is
reported rather than silently escaping the enclosing policy. Harness protocol
or storage changes require requalification of these version-sensitive adapters.

The Git metadata boundary protects the current checkout from worker commits;
it is not an adversarial OS container or a promise that arbitrary connected
tools lack remote effects. Do not describe the full permission-control goal as
qualified until those provider/tool paths have been independently exercised or
enclosed. Authentication remains in the selected Shell; the runtime never
copies private chats to an unselected Provider or creates a fallback model.

## Shared CLI / HTTP API

All clients use the same coordinator. `Authorization: Bearer <token>` is
required for every request; Origin, when supplied, and Host must match the
loopback server. Mutations use JSON. Never put the token in a query string.

| Request | Meaning |
| --- | --- |
| `GET /api/tasks` | Bounded task summaries |
| `GET /api/procedures` | Compact summaries of Host-injected immutable products |
| `GET /api/procedures/:id/:version` | Describe one exact product including schemas |
| `POST /api/tasks` | Validate a formal Run Request, create its deterministic Run identity and start it |
| `GET /api/tasks/:id` | Current task revision and state |
| `POST /api/tasks/:id/command` | `{requestId, expectedRevision, action, ...payload}` |
| `GET /api/tasks/:id/events?after=N` | Up to 100 events with durable cursor |
| `GET /api/tasks/:id/handoff` | Readable JSON handoff, reports, declared outputs and optional Git diff |
| `GET /api/tasks/:id/artifact?id=HASH` | Retrieve a task-associated context, report or candidate |
| `POST /api/probe` | Protocol observation for a selected workspace, no model call |

Task commands include `start`, `resume`, `pause`, `cancel`, `input`, `answer`,
`permission`, `reconcile`, `limits`, `binding`, `finding`, `stage`,
`commit` and `finish-commit`. `pause` and `cancel` are refused while recovery
(`reconciling`) or an authorized stage/commit finalization is still pending;
finish that step instead of racing it for the checkout lease. Their validation is owned by
[`coordinator.mjs`](src/coordinator.mjs). Reuse the **same** request ID, revision
and body when retrying an uncertain HTTP response. Reusing an ID with different
content fails. Read the current revision after a conflict; elapsed time never
means approval. A commit command includes the exact `candidate` identity and
`message`; it grants no push authority.

A formal Agent-started Run uses packaged role defaults but supplies explicit
authority and resources:

```json
{
  "schemaVersion": "openadam.agent-host-procedure-run-request.v0.1",
  "procedure": { "id": "org.openadam.research-brief", "version": "1.0.0" },
  "inputs": {
    "goal": "Compare two adoption approaches",
    "audience": "Independent developers"
  },
  "grants": ["model.invoke", "network.read"],
  "resources": {},
  "limits": {
    "maxDurationMs": 1800000,
    "maxNodeExecutions": 100,
    "maxAgentTurns": 12,
    "nodeTimeoutMs": 300000,
    "maxAttemptsPerNode": 4,
    "maxOutputBytes": 256000
  },
  "idempotencyKey": "caller-owned-stable-key"
}
```

Retry the exact body with the same `idempotencyKey`; different content for that
key is rejected. Procedure source, validation and packaging belong to the
developer workflow, outside this consumer API.

SQLite transactions own task revisions, command receipts, pending deliveries
and state transitions. Process ownership plus a checkout-level lease prevents
two coordinators from writing the same checkout. Native clients do not honor
that lease: content fingerprints detect their changes at handoff, review and
commit boundaries. Owned subprocess groups are stopped before releasing a
writer lease; a stopped response alone is insufficient. Late messages are
retained without advancing superseded attempts.

## Provider mechanics

The adapters use the selected harness rather than a same-named raw model API.
Current public references: [Codex app-server](https://learn.chatgpt.com/docs/app-server),
[Grok ACP](https://docs.x.ai/build/cli/headless-scripting),
[Grok sandbox limits](https://docs.x.ai/build/features/sandbox),
[ZCode Remote Control](https://zcode.z.ai/en/docs/remote-control).
ZCode's CLI `--help` separately declares its stdio app-server; qualify that
protocol against the installed CLI version. The remote web interface is not
silently replaced with a hand-copied bridge.

No portable Capability/Procedure binding is declared by this internal runtime.
The standards still own portable semantics and conformance, while Direct
Runtime retains its existing read-only, idempotent, closed-world admission.
