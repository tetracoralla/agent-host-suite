# Report v0.5 migration

`openadam.agent-tool-observer.report.v0.5` removes the legacy
receipt-derived `procedures` and `capabilities` arrays. The unpublished
Procedure receipt and human-checkpoint formats are no longer accepted by the
CLI or projected into reports.

Current Procedure, Capability, and projected MCP execution observations remain
available through `semanticExecutions` when Direct Execution Runtime emitted
the closed metadata-only observation format. Existing private legacy database
rows are not rewritten or promoted; ordinary retention may age them out.
