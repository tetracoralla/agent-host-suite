# Architecture

```text
Capability / Procedure standards (independent, normative)
                         |
Provider releases -------+------ compatibility manifest
                         |                |
                         v                v
                 Agent Host Suite manager
                   |       |        |
             host adapter  |   optional observability
                   |       |
          Codex / Claude    +--- Direct Execution Runtime
             official              |
          extension point      provider bindings
                   |               |
                   +------ provider artifacts
```

## No shell fork

The manager calls documented host extension commands and writes only state
owned by those public mechanisms. A shell update may require a fresh
compatibility check, but it does not overwrite a patched runtime because the
suite never patches the shell.

## No central Agent tool

The model continues to see provider-specific domain tools. It never receives a
generic `invoke(provider, operation, opaqueInput)` surface. Once a host already
has a selected, validated Capability or Procedure and structured input, it can
send that closed work below the model to Direct Execution Runtime.

## Independent repositories

The architecture, standards, runtime, providers, observer, analyzer, and suite
retain independent histories and releases. The suite repository stores only:

- schemas for its own manifest and state;
- compatibility and profile declarations;
- host adapter and lifecycle code;
- a small human management app;
- release automation and checks.

Provider source is never vendored. Release archives may contain independently
licensed provider binaries as verified nested artifacts, with their original
licenses, notices, SBOMs, identities, versions, and hashes preserved.

## Private state

Installed paths, local development roots, service sockets, process state, and
observations live in a user-private state directory. Tracked examples contain
placeholders only. The manager writes state atomically and records which host
entries it created so removal cannot claim ownership of pre-existing entries.
