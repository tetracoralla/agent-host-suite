# Review contract

Review the suite as one installation and lifecycle product.

## Required lanes

### Development regression

- syntax, tests, manifest/schema validation, package contents, legal files;
- fail-closed handling for unknown fields, hash mismatch, unsafe paths, host
  conflicts, partial setup, and state corruption;
- update and rollback retain one recoverable complete set;
- uninstall preserves pre-existing host entries and removes suite-created
  entries.

### Installed Agent flow

- use a fresh host session after install or update;
- reacquire the installed plugin path, version, and live tool registry;
- run ordinary Math Anchor and Migratory Time prompts and record the selected
  tools, calls, retries, and fallbacks;
- report Codex and Claude independently.

### Direct runtime flow

- reacquire provider schemas and bindings from installed artifacts;
- run one Math and one time-zone work order through the local service;
- exercise timeout/cancellation, replacement, overload, shutdown, and restart;
- verify observations do not contain inputs or results.

### Human runtime flow

- complete setup/status/doctor/update/rollback/observability-disable/uninstall
  in the built macOS app;
- verify error recovery and keyboard/accessibility paths;
- inspect the current rendered surface separately from build results.

### Distribution

- install on a clean supported machine from release artifacts, not sibling
  source checkouts;
- verify every detached digest, nested license, notice, SBOM, code signature,
  notarization ticket, and Gatekeeper assessment;
- distinguish macOS arm64, macOS x86_64, Linux, and Windows results.

## Claim boundary

Passing this repository's checks does not establish that provider semantics are
correct, that a shell vendor adopted the standards, that every Agent will
select the tools, or that another device works. Report each observed host,
artifact, and flow exactly.
