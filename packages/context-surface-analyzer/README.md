# Context Surface Analyzer

> **Source ownership:** this is a backstage Agent Host package. Agent Host may
> call its CLI for explicit snapshots; it is not a default Agent-visible tool
> or independently marketed product.

A local, deterministic utility for measuring one explicit Agent tool-catalog
snapshot and comparing two snapshots.

It reports canonical UTF-8 bytes and SHA-256 digests, tool/schema counts, exact
duplicate schemas, hard name collisions, declared budget checks, and deltas.
Optional token counts remain externally measured and fully labeled; the product
does not infer tokens from bytes or decide whether a tool is useful.

## Run

Requires Node.js 22 or newer and has no third-party runtime dependencies.

```sh
npm run check
node src/cli.js analyze examples/baseline.json
node src/cli.js diff examples/baseline.json examples/updated.json
npm start
```

The web surface opens at `http://127.0.0.1:4173`. Use `--port 0` to select an
ephemeral port. A snapshot can be pasted or loaded from a bounded local JSON
file; the browser does not retain it after the page is closed.

## Snapshot authority

Acquire each snapshot from the current provider, host, or an authorized
exporter. This product deliberately does not discover a host, start arbitrary
MCP servers, crawl files, or treat repository fixtures as the current installed
catalog. Project the exported catalog into the closed
`context-surface.snapshot.v0.1` format before analysis and retain the exporter,
provider, and revision as the source of record.

## MCP

Start the newline-delimited JSON-RPC stdio server:

```sh
npm run mcp
```

It exposes two read-only tools:

- `context.analyze`: one snapshot to one analysis;
- `context.diff`: earlier and later snapshots to one comparison.

Both accept snapshot JSON as bounded strings, so the Agent route has no ambient
filesystem authority. See [the product model](docs/PRODUCT_MODEL.md) for the
snapshot contract and exact semantics.

This portable runtime intentionally serves the MCP 2025 legacy era through
revision `2025-11-25`. Dual-era clients can identify that boundary from the
`server/discover` method-not-found response and fall back to `initialize`.
Modern-only 2026 transport is not claimed by this dependency-free plugin.

## Optional development Codex adapter

The package retains a Plugin adapter for bounded development comparison only.
Agent Host does not install it into the ordinary catalog. To validate it in an
isolated development Codex home:

```sh
npm run check
codex plugin marketplace add <package-root>
codex plugin add context-surface-analyzer@context-surface-analyzer
```

Start a new Codex task after installation so the Skill and MCP tools are loaded
from the same cached plugin version.

## Status

This is a local MVP. Development checks, direct runtime probes, installed Codex
routing, production load behavior, public-release readiness, and owner visual
acceptance remain separate claims. See [the review contract](docs/REVIEW_CONTRACT.md)
and [the first real-catalog dogfood note](docs/DOGFOOD.md).

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
