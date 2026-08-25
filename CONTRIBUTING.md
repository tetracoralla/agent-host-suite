# Contributing

Agent Host Suite is a multi-repository integration product. Keep Provider
behavior in its Provider repository, semantic meaning in Capability or
Procedure Contracts, direct execution mechanics in Direct Execution Runtime,
and installation/lifecycle behavior here.

Before opening a change:

1. run `npm ci` and `npm run check`;
2. on macOS, run `swift build`;
3. test ownership-preserving setup, update, rollback, and uninstall when host
   integration changes;
4. update the compatibility manifest only for immutable released artifacts;
5. keep machine paths, credentials, logs, observations, and generated app
   bundles out of Git.

Tests establish only the named development checks. Describe separately which
installed host, direct runtime, human app, and distribution flows you actually
ran.
