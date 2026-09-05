# Real-catalog dogfood

## 2026-08-25 observation

The first current-source dogfood used the real stdio `initialize` and
`tools/list` responses from:

- installed `decision-table` plugin version `0.1.1`;
- the current local Decision Table server at commit `6dddbd5`.

Only the snapshot fields owned by this product were projected: tool name,
description, input schema, and optional output schema. The current provider and
its MCP response remained the source of record.

Both catalogs measured:

- 3 tools;
- 6 schemas;
- 20,019 canonical catalog UTF-8 bytes;
- 9,701 canonical UTF-8 bytes for the largest tool;
- 0 exact duplicate schema groups;
- 0 exact name collisions.

The comparison reported zero byte, tool, and schema deltas; all three exact tool
names were unchanged and not reordered. This establishes a current structural
parity observation for that acquisition, not Decision Table correctness,
installed-host routing quality, tool value, or a reason to keep or retire any
tool.

## Product decision from the run

The analyzer answered a real catalog-size and installed-versus-source parity
question once it received explicit snapshots. Snapshot acquisition stays with
the owning host or exporter: adding passive host discovery or arbitrary MCP
process execution here would enlarge the authority and credential boundary.

The human surface now accepts a bounded local snapshot file as well as pasted
JSON. The Agent surface remains two one-call operations over explicit snapshot
strings.

Reacquire both catalogs before relying on these numbers; this note is a dated
continuation anchor and may become stale.

## Installed Agent route

The repository-local marketplace was added to Codex and plugin version
`0.1.0+codex.20260825110723` was installed into the Codex plugin cache. Current
host inspection showed:

- the plugin installed and enabled;
- MCP server `context_surface` enabled from the cached plugin root;
- the cached manifest, Skill, and MCP runtime byte-identical to the packaged
  source for the files checked;
- installed `context.analyze` and `context.diff` returning structured results;
- an unknown tool argument returning `UNKNOWN_FIELD`, followed by a successful
  call in the same server process.

The first cold Codex task exposed a real carrier defect: the server fixed its
initialize response to MCP revision `2025-06-18`, while the current host
requested `2025-11-25`. Local tests had repeated the old revision and therefore
missed the failure. The server now negotiates the current revision plus the
supported legacy revisions, with an explicit latest-version fallback regression
for an unknown revision.

After reinstall, a fresh ordinary-language Chinese task selected
`context.analyze` once, made one domain-tool call, used no generic fallback, and
reported the structured result. The host initially supplied an incomplete
versioned Skill cache path; the Agent located and read the actual installed
Skill before the domain call. That path recovery added three shell calls and is
a current Codex host-loading warning, not product routing work or a reason to
claim a zero-overhead route. The run's full Agent token usage is not comparable
to a no-plugin baseline, so it supports no token-savings claim.

## Human runtime

A headed browser run completed this sequence against the local server:

1. load `baseline.json` through the file selector and analyze it;
2. switch to Compare, load `updated.json`, and obtain the expected add/remove/
   change summary;
3. replace the updated snapshot with malformed JSON and see `INVALID_JSON`;
4. reload the valid file and complete the comparison again without stale error
   state.

The final fresh page exposed the selected operation with `aria-pressed` and no
startup console error. This is a runtime task observation; owner visual and
business acceptance remain pending.
