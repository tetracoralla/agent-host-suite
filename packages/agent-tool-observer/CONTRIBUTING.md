# Contributing

Agent Tool Observer is a local, metadata-only measurement product. Changes must
preserve the boundary that raw prompts, arguments, results, credentials, and
source paths are neither retained nor uploaded.

Before opening a change:

1. run `npm ci` and `npm run check`;
2. add the smallest negative regression for parser, cursor, migration,
   retention, or installer changes;
3. test install, repeated install, status, uninstall, and explicit purge when
   lifecycle behavior changes;
4. use synthetic fixtures rather than real Agent logs;
5. keep local databases, LaunchAgent files, logs, and generated reports out of
   Git.

Report observations and measurements precisely. A usage count does not by
itself establish correctness, utility, routing quality, or a retirement
decision.
