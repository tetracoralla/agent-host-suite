# Unnamed capability exercise

This optional exercise helps a person explore whether an Agent notices and
uses an installed capability on an ordinary task without being told its product
name. It is not an acceptance gate, a universal adoption score, or a requirement
for using Agent Host. A user or their selected Agent may run it, adapt it to a
more relevant task, interpret the observations differently, or ignore it.

This checkout does not claim a completed live exercise. A source build, Host
status, or observation count cannot decide what an Agent understood or whether
the resulting work was useful. The participant inspects the task and work
product, then owns any conclusion they choose to draw.

## Keep the layers separate

| Layer | What it can say | What it cannot say |
| --- | --- | --- |
| Host readiness | The selected tools, connection, and projection appear ready for a new task. | That a session discovered, chose, or benefited from a tool. |
| Session observation | A supported Provider record contains a direct call, an error, or only a static reference. | Why the Agent chose it, whether the result entered the work, or whether another route was better. |
| Work product | The requested icons are visible and the page still serves its brief. | Which tool caused them unless the task record and artifact establish that link. |
| Participant interpretation | What this task means for this participant's current decision. | A permanent verdict for other Agents, tasks, owners, or future versions. |

Host `status`, `tools status`, `doctor`, `doctor --featured-readiness`, Manager
copy, and observation counts are not adoption evidence. They remain useful
context. Observer may also preserve bounded Provider-reported context when it
exists, but neither requires it nor turns it into a Host judgment.

Do not patch Codex, Claude Code, ZCode, or another Agent app. If the purpose is
to explore unprompted discovery, do not attach this document,
[`FEATURED_CATALOG.md`](FEATURED_CATALOG.md), Armorial source, or a “please use
Armorial” instruction to the task.

## Host context, when relevant

On a machine with Agent Host, a bound featured install, and a supported Agent
app, this command can check the Host side:

```text
agent-host doctor --featured-readiness --json
```

Its `status` / `userStatus` covers required tools, connection, and projection.
`recipe.consistency` separately records the working set as an experimental
variable. A `local-dogfood` profile name is not itself a user-level failure,
and the report always sets `adoptionEvidence` to `false`.

If the Host result is warning or error, record that limitation. Repair it when
the question depends on current projection, or continue if the participant is
deliberately studying the failure. Do not convert readiness into a task verdict.
When bindings changed, use a **fresh Agent task** because an already-open task
may retain its earlier catalog.

## Runnable page situations

Copy one fixture out of this repository into a workspace that does not contain
Agent Host docs, Armorial source, or this exercise:

```text
docs/fixtures/adoption/ops-console/
docs/fixtures/adoption/settings/
docs/fixtures/adoption/library/
```

Each folder contains an unfinished page and a paste-ready `brief.md`. The brief
does not name an icon product. Open a new Agent task and use that brief as the
first message. The Agent edits `index.html` in the copied folder.

The three fixtures cover different icon situations:

- **North Pier ops console** — navigation, toolbar, status, and empty-state
  placeholders share one operational chrome.
- **North Pier berth settings** — object icons and primary or destructive
  actions coexist in one settings page.
- **North Pier harbor library** — empty-state art, actions, and row type marks
  need a coherent visual family.

These are examples, not a quota. One relevant task can answer a narrow question;
several different tasks can expose variation. A participant may substitute a
task from their own ecosystem when it is safe to share with the chosen Agent.

## Observe while acting

1. Let the Agent work normally. Do not stop it to complete a protocol form.
2. Open the delivered page and inspect whether the requested result is visible,
   usable, and still faithful to the brief.
3. If monitoring was already enabled, the Manager Task activity card or
   `observability task-sources` can show direct calls, errors, and static
   references. `observability export-task` can export bounded metadata for one
   selected task. Monitoring is optional and must not be enabled merely to make
   this exercise valid.
4. Record only the facts needed for the participant's decision. Add an
   interpretation if useful, and identify who made it.

Do not make one observation do the work of another:

- A direct call shows execution, not that its result entered the artifact.
- A tool name inside nested input is a static reference, not execution.
- A finished page does not by itself identify the source of its icons.
- No observed call does not reveal the Agent's reason or prove the capability
  was absent from its context.
- One successful or unsuccessful task does not settle all future tasks.

## Optional comparison

When the participant is deciding between concrete routes, copy the original
fixture again and run a separate control session. It may name an alternative,
such as Lucide or hand-drawn SVG. Compare the rendered pages and the effort that
mattered in this situation: semantic fit, visual consistency, geometry,
retries, repairability, and context burden.

This comparison is optional. It is a local judgment about those artifacts, not
a Host metric or a claim that every participant should make the same choice.

## Small factual note

Use as much or as little of this note as the decision needs. Do not commit local
paths, transcripts, or secrets.

```text
Situation:
Date and Agent app:
Fresh task after the relevant bindings: yes | no | unknown
Prompt named an icon product: yes | no
Host readiness context: ok | warning | error | not checked

Work product: completed | partial | not completed
What is visibly present:
Direct tool observations:
Static references (if any):
Errors or missing coverage:
Source-reported context (optional, if available):
Artifact link between tool output and final work: established | not established | unknown

Optional comparison:
Participant interpretation (optional):
Interpretation by: owner | developer | selected Agent | other
Decision or next experiment (optional):
```

A useful note can end with uncertainty. The exercise is complete when the
participant has enough information for the decision they are actually making,
not when a fixed number of tasks or fields has been filled.

## Related Host facts

- Featured membership and the bound-release path:
  [`FEATURED_CATALOG.md`](FEATURED_CATALOG.md)
- Working set vs session Skill/MCP paths:
  [`DISCOVERY_PROJECTION.md`](DISCOVERY_PROJECTION.md)
- Neutral task activity and observation limits:
  [`TRACE_PLANE.md`](TRACE_PLANE.md)
