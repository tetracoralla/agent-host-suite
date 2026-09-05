# Capability HTTP Bridge

> **Source ownership:** this is a Host-internal transport package. It is not an
> independently marketed product or Agent-visible tool.

Capability HTTP Bridge lets one explicitly configured remote service implement
an existing OpenAdam Capability while the Host continues to execute the exact
local `openadam.capability-jsonl.v0.1` adapter boundary.

```text
selected Capability call
  -> Direct Execution Runtime
  -> local Capability HTTP Bridge process
  -> one configured HTTPS endpoint
  -> exact semantic result or error
```

The bridge is transport, not meaning. A Provider product or instance must still
bind one current Capability Profile, Provider Manifest, operation set, and
input/output schema digests. The remote service receives that exact identity in
every request. The bridge never exposes a generic Agent tool and never chooses
an endpoint, Capability, Provider, model, or operation.

## Provider product and Provider Instance

The installed bridge code is a **Provider product dependency**. A runnable
**Provider Instance** additionally needs an untracked `instance.json` that fixes:

- one endpoint;
- one Capability id and version;
- a closed operation allowlist;
- timeout and response-byte bounds;
- either no authorization or a macOS Keychain bearer-token reference.

The instance file contains only the Keychain service/account reference, never
the token. The adapter accepts no token in arguments, environment, JSONL input,
or URL. HTTPS is mandatory outside numeric loopback. Redirects and automatic
retries are disabled.

Copy [`examples/instance.example.json`](examples/instance.example.json) to an
untracked Provider Instance root and configure the matching Provider Manifest.
The remote endpoint contract is documented in
[`docs/PRODUCT_MODEL.md`](docs/PRODUCT_MODEL.md).

## Checks

```sh
npm run check
```

The package tests the HTTP boundary and then builds a temporary Provider
Instance that Direct Execution Runtime executes through a real loopback HTTP
server. The pilot uses no credentials, model, user Host state, or network
outside the local machine. It proves the current carrier composition only; it
does not establish a real endpoint's health, credentials, semantic correctness,
privacy approval, adoption, or installed Agent routing.
