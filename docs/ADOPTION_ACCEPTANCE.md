# Unnamed adoption acceptance

This is a protocol for a machine that already has Agent Host, a bound featured
install, and a supported Agent app. It is not a claim that adoption already
happened.

This source checkout, and the Linux construction box that prepared it, did **not** complete live unnamed adoption. There is no macOS Host GUI or full
Agent session here to score. A person with Host plus Agent follows the
checklist below and records pass or fail.

Host `status`, `tools status`, `doctor`, `doctor --featured-readiness`,
Manager copy, and observation / usage counts are not adoption evidence.
They can only show Host user-level readiness (required tools, connection,
projection receipts) and a separate recipe-consistency check. A **fresh Agent task** after the current bindings is required.

Do not patch Codex, Claude Code, ZCode, or another Agent app. Do not attach
this document, [`FEATURED_CATALOG.md`](FEATURED_CATALOG.md), Armorial source,
or any “please use Armorial” instruction to the task.

## What “adoption” means here

Adoption is the Agent, on a realistic page task that never names Armorial,
choosing that installed icon tool and leaving icons **in the work product**.

| This is adoption | This is not adoption |
| --- | --- |
| A fresh session, unnamed prompt, icons visible in the delivered HTML/SVG | Host working-set `active`, doctor OK, or a healthy projection receipt |
| Session used Armorial MCP tools or the managed `scripts/armorial` launcher | Historical call counts, offered-tool lists, or Skill path existence |
| Result compared with Lucide or hand-drawn geometry on the same page | An old session that still holds a previous catalog |
| Operator judged the page, not the CLI | A prompt that names Armorial, IconPark, or “use the icon tool” |

Discovery (session loaded Skill/MCP) is a prerequisite. It is still not
adoption. See [`DISCOVERY_PROJECTION.md`](DISCOVERY_PROJECTION.md).

## Preconditions (Host only)

On the machine that will run the Agent:

1. Install a **bound** featured environment and select the featured working
   set. There is no GitHub Release asset in this checkout; use an
   owner-issued bound catalog or `AGENT_HOST_FEATURED_CATALOG_URL`. See
   [`FEATURED_CATALOG.md`](FEATURED_CATALOG.md) and
   [`UNSIGNED_PREVIEW.md`](UNSIGNED_PREVIEW.md).

   ```text
   agent-host profiles list --json
   agent-host setup --profile featured --host zcode --release-manifest /absolute/current.json
   agent-host tools set --profile featured
   ```

   `zcode` is an example. Use the Agent app you will actually task. Codex and
   Claude Code are the other public adapters.

2. Confirm Host precondition only:

   ```text
   agent-host doctor --featured-readiness --json
   ```

   User-level `status` / `userStatus` is tools, permissions, connection, and
   projection for the target task. It does not fail only because `profile` is
   `local-dogfood`. `recipe.consistency` is a separate check that the featured
   working set is selected. This report always sets `adoptionEvidence` to
   `false` and `userStatus` is not natural model choice.

   Unnamed adoption scoring requires JSON `status` equal to `ok` **and**
   `recipe.consistency` status equal to `ok`. `--skip-agent-apps` yields at
   most `warning` and is **not** a protocol pass: receipts were not inspected.
   `--deep` is rejected; this route does not probe Direct Runtime or pretend
   to judge the Agent.

3. If bindings just changed, or `restartRequired` is set, start a **fresh
   Agent task**. Do not reuse a thread that began before the current
   projection.

If user-level `status` is not `ok`, stop: required tools, connection, or
projection receipts are not ready. If `recipe.consistency` is not `ok`,
unnamed adoption cannot be scored on that Host even when user-level readiness
is `ok` (for example `local-dogfood` with a healthy Armorial projection).

## Workspace rule

Copy **one** task folder out of this repository into a workspace that does
**not** contain Agent Host docs, Armorial source, or this protocol:

```text
docs/fixtures/adoption/ops-console/
docs/fixtures/adoption/settings/
docs/fixtures/adoption/library/
```

Each folder is a self-contained unfinished page plus a paste-ready `brief.md`.
The briefs and HTML never name Armorial, Lucide, or IconPark. Do not add such
names. Do not point the Agent at this file.

Open a **new** Agent task. Paste that folder’s `brief.md` as the entire first
message. The Agent should edit `index.html` in that copied folder.

Run one unnamed task per session. Do not batch all three into one thread.

## Tasks

These are ordinary product-page jobs. The pass bar is icons in the page, then
whether the Agent chose Armorial without being told to.

### 1. North Pier ops console

- Fixture: [`fixtures/adoption/ops-console/`](fixtures/adoption/ops-console/)
- Work: navigation, toolbar, status chips, and the empty-state slot still
  have dashed placeholder squares.
- Why it is a real task: a night desk cannot ship a wireframe. Several icon
  consumers share one chrome.

### 2. North Pier berth settings

- Fixture: [`fixtures/adoption/settings/`](fixtures/adoption/settings/)
- Work: section headers and primary/destructive actions still lack icons.
- Why it is a real task: settings pages mix object icons (billing, members)
  with action icons (rotate a key, remove a berth).

### 3. North Pier harbor library

- Fixture: [`fixtures/adoption/library/`](fixtures/adoption/library/)
- Work: empty-state art, two actions, and sample row type marks are missing.
- Why it is a real task: empty states fail when the picture is a box, and
  list rows need durable type icons, not one-off doodles.

Two tasks are enough to score. Three is better if time allows. Do not skip
the fresh-session rule to go faster.

## Scoring

Score **task outcome** and **adoption outcome** separately.

### Task outcome (icons entered the work)

Pass only if all of these hold:

- The delivered `index.html` (and any SVG it references) is in the copied
  workspace.
- Placeholder `.icon-slot` squares are gone from the consumers the brief
  named.
- Icons are visible in the page (open the file in a browser). Chat-only SVG
  dumps or “here is an icon you could use” do not count.
- Layout, copy, and colors from the fixture remain; this is not a redesign.

Fail the task if placeholders remain, icons are only discussed, or the page
was replaced with a different product.

### Adoption outcome (unnamed Armorial use)

Pass only if the task passed **and** all of these hold:

- The first user message did not name Armorial, IconPark, Lucide, or a
  specific icon product, and did not say “use the installed icon tool”.
- The workspace did not contain this protocol or Armorial source.
- The session started after the current Host bindings.
- The transcript shows Armorial MCP tools (`resolve_icon`, `search_icons`,
  `get_icon`, `get_icons`, `choose_icon`) and/or the managed
  `scripts/armorial` launcher supplying those icons.

Fail adoption if the Agent used Lucide (or another icon corpus), emoji,
CSS shapes, or model-authored path data **instead of** Armorial, even when
the page looks finished. That is a task pass and an adoption fail.

A named “please use Armorial” run can still be useful as a control. It is
not unnamed adoption.

### Host surfaces (never a pass)

Do not record adoption from:

- `agent-host status` / Manager “selected” / working-set `active`
- `agent-host doctor` or `doctor --featured-readiness`
- `host status` identity match or `cacheStatus: matched`
- `usage` historical calls, offered-tool inventories, or Observer counts

Those facts belong in the precondition column of the scorecard only.

## Comparison with Lucide or hand-drawn icons

Adoption is not only “did a tool run”. Compare **steps** and **quality**
with the obvious alternatives on the **same** fixture.

1. Keep the unnamed session’s delivered page.
2. Copy the original fixture again into a second workspace.
3. Start another **new** session. This control **may** name the alternative,
   for example “use Lucide icons” or “draw the SVG yourself; do not call an
   icon service”.
4. Record, for unnamed vs control:

   | Axis | What to write down |
   | --- | --- |
   | Steps | How many tool/file turns until icons were in the page; retries; dead ends |
   | Fidelity | Did icons match the labeled action, or only the old placeholder shape? |
   | Consistency | One family and stroke across nav, actions, and empty state, or a mix? |
   | Geometry | Catalog strokes vs model-authored paths vs emoji |
   | Cost | Rough turn count and whether SVG dumps filled the context |

The comparison is operator judgment on that pair of pages. It is not a Host
metric and not a claim about all future tasks.

If the unnamed session already chose Lucide or hand-drew, that session is
the alternative. A named-Armorial control on a third copy is optional and
still not unnamed adoption.

## Scorecard

Copy this block per task. Fill it on the Host+Agent machine. Do not commit
machine paths, transcripts, or secrets to this repository unless the owner
asks for a redacted note.

```text
Task: ops-console | settings | library
Date:
Agent app: zcode | codex | claude
Fresh session after current bindings: yes | no
doctor --featured-readiness status: ok | warning | error
  (warning/error: do not score adoption)
Prompt named Armorial/Lucide/IconPark: yes | no
Workspace was a copy without Host/Armorial docs: yes | no

Task outcome (icons in the page): pass | fail
Adoption outcome (unnamed Armorial): pass | fail | not-scored
Icon source actually used: armorial | lucide | hand-drawn | emoji/css | mixed | unknown
Evidence for source (tool names or files, no secrets):
Host status/counts used as adoption proof: yes | no  (yes => invalid)

Lucide or hand-drawn comparison (optional control session):
  Control named: lucide | hand-drawn | named-armorial | none
  Steps (unnamed vs control):
  Quality (unnamed vs control):

Notes:
```

A protocol run is complete when at least two tasks have a task outcome and
an adoption outcome, or an explicit fail at preconditions. “Should adopt”
without a scorecard is not a result.

## Related Host facts

- Featured membership and the bound-release path:
  [`FEATURED_CATALOG.md`](FEATURED_CATALOG.md)
- Working set vs session Skill/MCP paths:
  [`DISCOVERY_PROJECTION.md`](DISCOVERY_PROJECTION.md)
- Observation counts are not adoption:
  [`TRACE_PLANE.md`](TRACE_PLANE.md)
