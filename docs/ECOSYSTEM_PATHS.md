# Ecosystem participation paths

Agent Host keeps a small waist: it admits exact tool bytes, connects them
through supported Agent-app surfaces, manages their local lifecycle, and can
record bounded facts. It does not decide which tools every person should use,
turn observations into a universal score, or require providers to move their
product meaning into Host.

The paths below are deliberately different. They meet at artifact admission
and lifecycle safety, not at one mandatory product template.

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
  --json

agent-host component import \
  --artifact /absolute/provider.tar.gz \
  --binding /absolute/binding.json \
  --json
```

Import defaults inactive and retains the Host-owned rollback/removal route.
Publishing a GitHub Release, activating a live Agent tool, adding credentials,
or granting paths remains a separate owner decision.

## Decide what the observations mean

The Manager's visual task cards are optional invitations. They give a person a
recognizable task, expected form of outcome, and copyable starting prompt. They
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
