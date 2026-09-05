# Contributing

Context Surface Analyzer measures explicit tool-catalog snapshots. It does not
discover host state, retain catalogs, evaluate tool value, or authorize routing
changes.

Before opening a change:

1. run `npm ci` and `npm run check`;
2. preserve the deterministic CLI, MCP, library, and local web semantics;
3. add bounded negative tests for validation, protocol, or output-budget
   changes;
4. use synthetic catalog snapshots only;
5. keep host paths, credentials, real catalogs, build output, and temporary
   measurements out of Git.

When the portable plugin changes, verify that its runtime and legal files are
synchronized by the repository checks.
