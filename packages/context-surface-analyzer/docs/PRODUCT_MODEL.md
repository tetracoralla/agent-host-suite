# Product model

## Product task

Context Surface Analyzer lets an Agent-platform developer or operator inspect
one explicit tool-catalog snapshot or compare two snapshots without writing an
ad hoc counting and diff script.

The human task is to paste or load a snapshot, see its exact catalog size and
structural risks, then optionally compare an updated snapshot. The Agent task is
the same deterministic operation through one direct tool call.

## Shared core and surfaces

`src/core.js` is the only semantic implementation. It is used by:

- `context-surface analyze` and `context-surface diff` in the CLI;
- read-only MCP tools `context.analyze` and `context.diff`;
- local HTTP endpoints behind the minimal web surface;
- the repository-local Codex plugin and its thin routing Skill.

The product does not persist snapshots or results. The web surface keeps input
only in the current page. CLI file paths are deliberate human/operator
arguments; the MCP tools accept bounded snapshot JSON and have no filesystem
authority.

The portable MCP carrier serves the 2025 legacy protocol era through revision
`2025-11-25`, which is the current installed Codex route for this product. It
returns JSON-RPC `Method not found` to `server/discover`, allowing a dual-era
client to identify it as legacy and reconnect through `initialize`. It does not
claim the 2026 modern era; that requires the modern per-request envelope and
wire codec, not only a discovery response.

Snapshot acquisition remains outside the product. The current provider, host,
or authorized exporter owns the live catalog and its revision. This product
does not start an arbitrary provider, inspect a running host, or promote a
fixture into a current installed observation.

## Snapshot contract

The accepted format is `context-surface.snapshot.v0.1`:

```json
{
  "format": "context-surface.snapshot.v0.1",
  "source": { "id": "plugin-id", "revision": "1.0.0" },
  "tools": [
    {
      "name": "domain.operation",
      "description": "Short selection-oriented description.",
      "inputSchema": { "type": "object" },
      "outputSchema": { "type": "object" }
    }
  ],
  "measurements": [
    {
      "metric": "input_tokens",
      "value": 400,
      "source": "host-observed",
      "provider": "provider-id",
      "model": "model-id",
      "serialization": "tools-list-json",
      "tokenizerVersion": "optional-version"
    }
  ],
  "budgets": {
    "maxCatalogUtf8Bytes": 50000,
    "maxToolCount": 64,
    "maxLargestToolUtf8Bytes": 8000,
    "maxResultUtf8Bytes": 65536
  }
}
```

All product-owned objects reject unknown fields. `inputSchema` and
`outputSchema` remain JSON Schema payloads and may contain standard-defined
keywords; the product bounds their bytes, depth, and nodes but does not claim
to validate JSON Schema dialect semantics.

## Deterministic meaning

Objects are canonicalized by recursively sorting keys. Array order is retained.
Hashes use SHA-256 over UTF-8 canonical JSON. Therefore:

- `snapshot.canonicalUtf8Bytes` counts the whole canonical snapshot;
- `catalog.canonicalUtf8Bytes` counts the canonical `tools` array;
- per-tool and per-schema bytes count their canonical JSON;
- exact duplicate schemas share the same canonical schema digest;
- hard name collisions are repeated case-sensitive tool names.

Comparison matches tools by unique exact name. A repeated name on either side
is reported under `ambiguousDueToNameCollision` and is not guessed into a
one-to-one pair. Reordering is reported only when the two catalogs contain the
same set of unique names.

Token measurements are never derived from bytes. They are compared only when
all measurement identity labels match. Missing measurements stay missing.

## Limits

- snapshot JSON: 512 KiB each;
- tools: 128;
- schemas: 64 KiB canonical JSON each, depth 32, and 20,000 JSON nodes
  cumulatively across all input and output schemas in one snapshot;
- measurements: 16;
- complete result: 256 bytes through 128 KiB and may be lowered by the caller or snapshot;
- local HTTP request body: 2,200 KiB;
- MCP request line: 2,200 KiB, JSON-RPC id: 256 UTF-8 bytes, and complete
  serialized MCP response envelope: 129 KiB.

Limit failures use stable error codes and do not return the rejected source
payload.

## Layer decision and route budget

This is a concrete provider product with two direct tools, not a Procedure and
not a provider-neutral Capability standard. Analysis and comparison are
semantically distinct, stable user operations. Ordinary supported Agent tasks
should take exactly one domain-tool call. Invalid input should return one stable
error without retry or fallback.

It may later consume explicitly exported snapshots from Observer or feed
measurements to Evals, but it does not own either product's semantics and does
not modify them.

Its snapshots and measurements carry no conclusion by themselves. A consumer
must name the claim being assessed, reacquire current inputs, keep provenance
and freshness visible, and own the inference. No output from this product can
justify routing, retirement, value, or acceptance on its own.
The current provider or host catalog and its measurement source remain the
system of record; this product receives only a caller-supplied bounded snapshot.

## Non-goals

No live host inspection, telemetry daemon, automatic enable/disable, tool
retirement decision, utility score, similarity judgment, model inference,
network provider, plugin marketplace, account, approval flow, shared ABI, or
claim that smaller catalogs are inherently better.
