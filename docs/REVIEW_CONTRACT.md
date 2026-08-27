# Review contract

Review the suite as one installation and lifecycle product.

The lanes below are minimum coverage, not a completion runway. Reconstruct the
current environment, profiles, release channel, host bindings, service, and
manager surfaces from source and runtime before following them, keep at least
one discovery route that is not copied from these headings or the changed-file
list, and report out-of-contract findings and still-untested compositions;
completing every lane cannot by itself end the review.

## Required lanes

### Development regression

- syntax, tests, manifest/schema validation, package contents, legal files;
- fail-closed handling for unknown fields, hash mismatch, unsafe paths, host
  conflicts, partial setup, and state corruption;
- update and rollback retain one recoverable complete set;
- profile reduction removes only suite-created bindings outside the target set
  and restores displaced user bindings;
- every admitted MCP tool has a closed input and output schema, and a component
  with both MCP and maintenance CLI routes preserves both entrypoints;
- host inspection failure cannot be mistaken for an absent entry, and a failed
  managed replacement restores the prior Claude binding;
- lifecycle activity is bounded and contains actions and state, not prompts or
  tool inputs or results;
- uninstall preserves pre-existing host entries and removes suite-created
  entries.

### Installed Agent flow

- use a fresh host session after install or update;
- reacquire the installed plugin path, version, and live tool registry;
- run ordinary Math Anchor and Migratory Time prompts plus one task relevant to
  a local-dogfood tool, and record selected tools, calls, retries, and fallbacks;
- report Codex and Claude independently.

### Direct runtime flow

- reacquire provider schemas and bindings from installed artifacts;
- project one selected Math operation through its declared live schema lookup
  and verify the returned contract contains only that operation;
- run one selected Math operation, one two-item native Math batch, and one
  time-zone work order through the local service;
- exercise timeout/cancellation, replacement, overload, shutdown, and restart;
- verify observations do not contain inputs or results.

### Human runtime flow

- complete setup, Environment, Tools, Agent Apps, Activity, doctor, update,
  rollback, observability-disable, and uninstall flows in the built macOS app;
- verify the default manager refresh detects a broken direct route instead of
  promoting file/host presence to overall readiness;
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
correct, that an Agent-app vendor adopted the standards, that every Agent will
select the tools, or that another device works. Report each observed host,
artifact, and flow exactly.
