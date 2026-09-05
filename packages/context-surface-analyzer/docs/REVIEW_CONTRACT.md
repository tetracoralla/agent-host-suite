# Review contract

This is the minimum current-source review route. Passing it establishes only
the named development checks and local runtime observations; it is not
installed-host routing or owner visual acceptance.

## Authority chain

1. `docs/PRODUCT_MODEL.md` defines current product meaning and limits.
2. `src/contract.js` owns accepted snapshot syntax and cumulative bounds.
3. `src/core.js` owns canonical analysis and comparison semantics.
4. `src/cli.js`, `src/mcp-server.js`, and `src/ui-server.js` are adapters.
5. `plugins/context-surface-analyzer/` is the portable Codex carrier generated
   from the shared runtime and guarded against drift.
6. `test/` holds executable regressions. `npm run check` is the full local
   development entry point.

## Required commands

```sh
npm run check
node src/cli.js analyze examples/baseline.json
node src/cli.js diff examples/baseline.json examples/updated.json
node src/ui-server.js
```

The test suite must exercise MCP `initialize`, `tools/list`, a valid
`tools/call`, and an invalid `tools/call` over the actual stdio process. It must
negotiate installed-host legacy revision `2025-11-25` and one supported older
revision, and keep `server/discover` as an explicit `Method not found` boundary
until the product ships a real 2026 per-era transport.

## Review invariants

- Equivalent object key order produces the same canonical digest and byte
  count; array order remains meaningful.
- CLI, MCP, and web adapters call the shared core and preserve its result/error
  meaning.
- Snapshot-owned records and transport arguments reject unknown fields.
- Schema payloads are bounded as one cumulative request and never executed.
- Exact duplicate and collision labels do not imply semantic equivalence or
  value.
- Token values appear only when supplied with complete measurement labels. No
  byte-to-token estimate is emitted.
- A colliding tool name is not guessed into a diff pair.
- Output limits apply to complete CLI results, complete MCP tool payloads
  including structured content and the concise text item, and the bounded
  serialized JSON-RPC response envelope.
- MCP tools remain read-only, non-destructive, idempotent, and closed-world.
- Malformed JSON-RPC envelopes and ids are rejected before dispatch. Oversized
  lines are discarded through their newline, after which the same server
  process accepts a later valid request.
- A slow MCP output pauses input consumption until the writable stream drains,
  preventing sustained callers from growing an unbounded response queue.
- Malformed, oversized, too-deep, unknown-field, and result-budget failures use
  stable bounded errors without echoing source text; compact MCP errors
  preserve the original stable code before omitting bounded details.
- HTTP serves only the four allowlisted assets and two local POST operations.
  It has no general file route or network dependency.
- The portable plugin manifest, marketplace entry, Skill, MCP configuration,
  package version, and copied runtime agree with current source.
- Browser file selection enforces the snapshot input limit before submission
  and does not persist the selected file.

## Adversarial sequences

1. Analyze a valid snapshot, then the same object with reordered keys; require
   identical digest and canonical bytes.
2. Supply two tools with one exact name; require a collision and no inferred
   pair in a subsequent comparison, including when the repeated name exists
   only in the added or removed snapshot.
3. Supply the same schema under different tools; require one exact duplicate
   group. Change one keyword; require the group to separate.
4. Add an unknown top-level, tool, measurement, budget, HTTP, or MCP argument;
   require `UNKNOWN_FIELD` before analysis.
5. Exceed raw bytes, cumulative schema nodes, schema depth, schema bytes, tool
   count, and result bytes; require stable limit errors and successful handling
   of a later valid call.
6. Compare token measurements with a mismatched model, serialization, or
   tokenizer version; require no numerical delta across unlike identities.
7. Send missing-version, object-id, deeply nested-id, and oversized-line
   JSON-RPC messages; require bounded protocol errors, no process crash, and a
   successful ping on the same connection after each recoverable failure. Hold
   output backpressure and require request consumption to pause until drain.

## Reporting lanes

- **development regression:** syntax, build, unit/integration tests, and smoke;
- **runtime Agent flow:** actual stdio MCP lifecycle and calls, then installed
  plugin activation and cold-host selection as a separate observation;
- **runtime human flow:** actual local HTTP entry, analyze, compare, and invalid
  recovery;
- **business/experience acceptance:** owner judgment remains pending.

## Tools-dev workspace escalations

Report any proposed shared schema, provider manifest, Observer/Evals coupling,
installed namespace conflict, or aggregate context/resource concern to the
workspace owner. Do not solve it with a private local standard.
