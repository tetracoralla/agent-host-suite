# Ecosystem participation paths

Agent Host keeps a small waist: it admits exact tool bytes, connects them
through supported Agent-app surfaces, manages their local lifecycle, and can
record bounded facts. It does not decide which tools every person should use,
turn observations into a universal score, or require providers to move their
product meaning into Host.

The paths below are deliberately different. They meet at artifact admission
and lifecycle safety, not at one mandatory product template.
The desktop Manager is a convenience for managing these paths, not a required
per-call intermediary. Today's Codex archive import and Skill/MCP projections
are supported delivery formats, not the definition of all admissible future
capabilities. See the owning
[evolution policy](PRODUCT_MODEL.md#stable-responsibilities-evolving-integrations)
for when a new adapter or semantic contract is warranted.

## Use a released tool

A provider may publish a self-contained Codex plugin archive in its own GitHub
Release. The provider owns the task, semantics, Skill, runtime, license, release
notes, and support boundary. Agent Host can preview that public project, show
the human-readable identity, and add the compatible asset only after a person
chooses it.

```text
agent-host tools add --github https://github.com/OWNER/REPOSITORY --preview --json
agent-host tools add --github https://github.com/OWNER/REPOSITORY --json
agent-host tools update --tool COMPONENT --dry-run --json
agent-host component remove COMPONENT --dry-run --json
```

Preview does not install anything. Add defaults the new tool to inactive unless
`--activate` is explicit. A new Agent task is required after projection changes.
Armorial 0.8.0 is the current public end-to-end reference for this route; its
presence in the owner-selected featured profile is not a ranking or a claim
that it suits every task.

## Build and privately try a tool

The installed Agent Tool Development Kit is a contributor route, not a
permanent Agent MCP server. Its Skill helps an Agent reason about the product;
its CLI reports deterministic repository, package, and runtime facts.

From the installed Skill directory:

```text
scripts/openadam-dev doctor --json
scripts/openadam-dev inspect --root /absolute/provider-repository --json
scripts/openadam-dev check --root /absolute/provider-repository --json
scripts/openadam-dev pack --root /absolute/provider-repository --json
scripts/openadam-dev probe --root /absolute/provider-repository --json
```

`check` follows the provider's declared checks. `pack` creates sealed bytes but
does not publish, approve, install, or grant license rights. `probe` asks the
current Agent Host to admit the exact archive without changing installed state,
then exercises only declared closed read-only examples.

When the owner wants a private local trial, use the binding returned by Host
preview rather than hand-editing Agent configuration:

```text
agent-host component preview \
  --artifact /absolute/provider.tar.gz \
  --license-spdx Apache-2.0 \
  --standalone \
  --json > /absolute/provider.preview.json

agent-host component import \
  --artifact /absolute/provider.tar.gz \
  --binding /absolute/provider.preview.json \
  --json
```

Import defaults inactive and retains the Host-owned rollback/removal route.
Publishing a GitHub Release, activating a live Agent tool, adding credentials,
or granting paths remains a separate owner decision.

## Build and privately try a Procedure

Procedure Studio is the developer surface for reusable Procedure products. It
starts at a template or an existing project, but the Method Graph, input/output
contracts, scenarios and package identity remain ordinary source files owned by
the Procedure project. The canvas and source editor are two views of that same
model rather than a Host-only workflow format.

```text
npm run studio -- serve
```

The home surface uses the system folder picker, remembers recent projects and
can create a project from Blank, Capability orchestration, human-decision,
research/verification or Git development/review templates. A template is a
starting composition, not a permanent product category: authors can add,
remove, reconnect and configure Agent turns, direct Capability calls,
subprocedures, transforms and checkpoints in the same project.

`Package` saves the current canonical source, validates its contract and Test
scenarios, emits one sealed Procedure component archive, and runs standalone
Host preview. It does not install, activate, publish or modify a consumer Agent
environment. A private trial then uses the same exact-byte admission and
lifecycle path as another Host component:

```text
agent-host component preview \
  --artifact /absolute/procedure.tar.gz \
  --license-spdx Apache-2.0 \
  --standalone \
  --json > /absolute/procedure.preview.json

agent-host component import \
  --artifact /absolute/procedure.tar.gz \
  --binding /absolute/procedure.preview.json \
  --json
```

The import targets the selected installed Agent environment (the default one
unless `--state-root` names another already established environment). A
throwaway state directory is not an environment until the ordinary Agent Host
setup path has created it.

Agent Host Manager then owns installed availability, exact version, update,
rollback and removal. It distinguishes contract discovery, current invocation
evidence, current health and current-session observation; it does not become a
Procedure editor or Run console. Consumer Agents discover and invoke the exact
installed product through the headless Procedure route.

## Decide what the observations mean

The Manager's compact product rows are optional invitations. Local inventory is
shown first; recommendations and the searchable compatible catalog are separate
discovery surfaces. Each row gives a person a recognizable product mark, short
job label, current availability, and one direct action. A GitHub project is not
addable until its compatibility preview succeeds. A copyable example, when the
admitted tool has one, stays collapsed on the detail page. Copying it does not
start an Agent task or record adoption. The labels and examples
are Host editorial content for the current admitted set—not portable provider
metadata, a quality certificate, or a requirement for every integration.

Observer can retain supported facts such as offered/called/returned events,
runtime outcomes, versions, and bounded task activity. The user, provider, or
their Agent decides whether those facts matter for the current task. Adoption,
correctness, usefulness, comparative advantage, and the reason a tool was or
was not chosen remain outside Host unless a separate current assessment
actually establishes them.

## Responsibility boundary

| Participant | Owns |
| --- | --- |
| Provider author | useful task, domain behavior, Skill, runtime, limits, release, license, and support |
| Agent Host | exact admission, safe install/update/rollback/removal, supported Agent-app projection, and neutral bounded observations |
| User or environment owner | what to install, activate, connect, grant, publish, or remove, and how much weight to give the observations |
| Task Agent | contextual selection and composition within the available tools and the user's authority |

This boundary is intentionally permeable at the human decision points. Host may
offer a useful default or example without making it mandatory; a user may copy,
edit, ignore, or remove it. New Agent apps and provider formats should join
through their supported public extension surfaces rather than by expanding Host
into a universal problem-solving algorithm.
