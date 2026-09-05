---
name: analyze-context-surface
description: Use Context Surface Analyzer when the user supplies one explicit Agent tool-catalog snapshot to measure or two ordered snapshots to compare, especially for exact catalog bytes, tool and schema counts, name collisions, exact duplicate schemas, declared budget checks, or fully labeled caller-supplied token measurements. Do not trigger for live host discovery, semantic similarity, tool value, routing, or retirement judgments.
---

# Analyze Context Surface

Call `context.analyze` for one `context-surface.snapshot.v0.1` document and
`context.diff` for an earlier and later snapshot. The selected tool exposes the
complete input schema. Use exactly one domain-tool call for an ordinary valid
request and return a stable tool error without inventing a fallback for invalid
input.

Require an explicit snapshot from the current provider, host, or authorized
exporter. Do not claim that a repository fixture is the current installed
catalog, and do not ask this utility to inspect the host or filesystem.

Present exact structural facts concisely. Canonical UTF-8 bytes are not token
estimates. Duplicate schemas mean exact canonical equality, and collisions mean
exact case-sensitive repeated names; neither establishes semantic redundancy or
product value. Compare token measurements only when every identity label
matches. Never recommend routing, disablement, retirement, or acceptance from
this result alone.
