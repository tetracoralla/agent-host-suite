# Report v0.6 migration

`openadam.agent-tool-observer.report.v0.6` removes action-bearing portfolio
vocabulary from passive observations.

- `fix-candidate` becomes `high-observed-error-rate`;
- `fixCandidates` becomes `highObservedErrorRates`;
- `capabilityCandidates` becomes `repeatedUnmappedMcpUse` with signal
  `repeated-unmapped-mcp-use`;
- `procedureCandidates` becomes `repeatedToolSequences` with signal
  `repeated-tool-sequence`;
- empty `weakenRoutingCandidates` and `retireCandidates` fields are removed.

Each portfolio observation retains the measured basis and explicitly reports
`interpretationStatus: not-performed`. Older snapshots are rebuilt from the
current database. No stored event schema or collection source changes.
