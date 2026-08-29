# Product terminology

This document is the naming authority for Agent Host product copy, repository
documentation, and operator-facing messages. It separates what a person
installs from the architecture, the installed environment, independently
released tools, and their Agent-app integrations.

## Canonical terms

| Canonical term | Chinese working term | Meaning and use |
| --- | --- | --- |
| **Agent-Host Execution Architecture** | **Agent–Host 执行体系** | The independently adoptable architecture. It is not an application or an installable product. Use the shorter **Agent-Host architecture** after the first mention. |
| **Agent Host** | **Agent Host** | The user-facing product name. People install, open, update, or uninstall Agent Host. Do not add *Suite*, *platform*, *system*, or *client* in ordinary product copy. |
| **Agent Host Manager** | **Agent Host 管理器** | The macOS management application when it must be distinguished from the whole product. Its displayed application name remains **Agent Host**. Do not call it a client. |
| **Agent environment** | **Agent 环境** | The installed compatibility set on one device: one Agent Host release, selected tool versions, Agent-app integrations, local execution state, and optional monitoring state. This is the main object the Manager installs and checks. |
| **Agent Host components** | **Agent Host 基础组件** | Installation, compatibility, Agent-app connection, health, lifecycle, and Direct Runtime components. These support the environment; they are not Agent tools and are not a separate user-facing product. |
| **Agent app** | **Agent 应用** | A product such as Codex or Claude Code that hosts an Agent and loads tool integrations. Use **host** only in technical contracts, adapters, commands, and stable data fields. Do not describe an Agent app as an Agent Host client. |
| **Agent tool** | **Agent 工具** | An independently released product that an Agent calls to perform domain work, such as Math Anchor or Migratory Time. Each tool retains its own name, release, license, and semantics. |
| **Standard tool set** | **标准工具集** | The small set of Agent tools selected by the `standard` profile. Direct Runtime is an infrastructure component and is not counted as a Standard tool. |
| **tool integration** | **工具接入** or **工具集成包** | The supported carrier that makes one Agent tool available in one Agent app, such as a Codex Plugin or Claude MCP binding. A plugin or binding is not the tool itself. |
| **Direct Execution Runtime** / **Direct Runtime** | **直接执行运行时** | The infrastructure component that runs already-selected structured work without another model relay. It is not a generic model-facing Agent tool. |
| **compatibility set** | **兼容集** | The exact versions, artifacts, hashes, integrations, and local state intended to work together. An installed compatibility set is the device's Agent environment. |
| **compatibility release** | **兼容版本** | An immutable, distributable compatibility set. It coordinates releases; it does not certify universal tool value or live health. |
| **local tool monitoring** | **本地工具监测** | The user-facing name for optional local operational metadata. Use **observability** for the technical profile, commands, schemas, and source identifiers. |

Capability Contracts and Procedure Contracts remain independent semantic
standards. They define reusable operation meaning and settled method; they are
not Agent Host components, Agent tools, or objects an ordinary user manages in
the primary interface.

## Relationship

```text
Agent-Host Execution Architecture
└─ Agent Host
   ├─ Agent Host Manager       human management application
   ├─ Agent Host components    installation, health, lifecycle, Direct Runtime
   └─ Agent environment        installed state on one device
      ├─ Agent apps             Codex, Claude Code
      ├─ Agent tools            Math Anchor, Migratory Time
      └─ tool integrations      Codex Plugin, Claude MCP binding
```

The Manager controls installation and lifecycle through each Agent app's
supported extension points. It does not broker ordinary tool calls. During an
Agent task, the Agent app calls each independently named tool through that
tool's integration. An Agent app or automation may send already-selected,
structured work to Direct Runtime below the model.

The unified product experience comes from one Agent environment with one
compatibility view, ownership record, health check, update, rollback, and
uninstall path. It does not require merging independent tools into one binary
or replacing them with a generic invocation surface.

## Product copy

Prefer:

- “Install Agent Host.”
- “Open Agent Host to check your Agent environment.”
- “Connect Math Anchor to Codex.”
- “Install or remove an Agent tool.”
- “Your Agent environment is healthy.”
- “Start a fresh Codex task to load the installed tools.”

Avoid:

- “Install the Agent-Host system” when referring to the product.
- “Open the Agent Host client.”
- “Codex is an Agent Host client.”
- treating Direct Runtime as part of the Standard tool set;
- using *plugin*, *MCP binding*, *provider*, and *tool* as interchangeable
  user-facing words.

## Stable technical identifiers

This terminology does not rename stable technical identifiers. Keep the
repository `agent-host-suite`, npm package `@openadam/agent-host-suite`, CLI
`agent-host`, Swift target `AgentHostManager`, bundle identifier, state paths,
schema identifiers, JSON fields such as `hosts` and `suiteVersion`, service
labels, and API names unchanged unless a separate migration is approved.

In implementation-facing text, **Agent Host Suite** names this repository and
its distribution unit. **host**, **provider**, **plugin**, **client**, and
**observability** remain valid when they identify a protocol role, stable
contract, source module, command, or machine field. Product-facing text should
translate them to the canonical human terms above.
