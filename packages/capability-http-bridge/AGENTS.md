# Capability HTTP Bridge package contract

Read `docs/PRODUCT_MODEL.md` and `docs/REVIEW_CONTRACT.md` before changing or
reviewing this package.

This Agent Host internal package is a local transport bridge for one already selected and typed
Capability Provider instance. It is not a Capability, provider registry,
credential vault, generic Agent tool, semantic adapter, or remote Agent
protocol.

- Preserve exact Capability JSONL request and result/error semantics.
- Permit HTTPS endpoints only, except numeric loopback HTTP for bounded local
  tests and development.
- Keep credentials out of instance files, arguments, environment variables,
  requests, responses, and diagnostics. The only credential integration is an
  explicit macOS Keychain reference resolved by `/usr/bin/security`.
- Never retry automatically, follow redirects, or turn transport failures into
  provider-owned domain errors.
- Keep endpoint, account, credential availability, and health as current local
  Provider Instance state. Do not commit an `instance.json` or credentials.
- Do not add a model-facing generic invocation surface.
- Do not recreate this Host-owned bridge as a standalone product repository
  without a verified independent consumer and release boundary.
- Do not commit, publish, install, or configure a real remote endpoint without
  explicit owner authority.

Run `npm run check`. Report repository regression, Direct Runtime pilot,
remote endpoint/credential availability, installed Agent flow, and owner
acceptance separately.
