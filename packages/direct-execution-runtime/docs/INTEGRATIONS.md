# Integration boundary

Direct Execution Runtime invokes separately installed providers. Provider
source code, releases, licenses, configuration, credentials, and domain
semantics remain outside this Host package.

Human-facing documentation uses a provider's public product name plus a short
role description. Runtime configuration uses stable machine identifiers. A
local checkout directory is never a public product identity.

## Current public integration pilots

| Product | Role | Public repository | Runtime identity | Carrier |
| --- | --- | --- | --- | --- |
| Math Anchor | Deterministic mathematics | [tetracoralla/math-anchor](https://github.com/tetracoralla/math-anchor) | `io.github.tetracoralla.math-anchor` | stdio MCP |
| Migratory Time | Time-zone conversion | [tetracoralla/migratory-time](https://github.com/tetracoralla/migratory-time) | `io.github.tetracoralla.migratory-time` | Capability JSONL |

These names identify independent products; they do not make either provider a
dependency bundled with this runtime. Users must install and configure the
provider separately.

The public Math Anchor path is executable through
[`docs/PUBLIC_DEMO.md`](PUBLIC_DEMO.md). It reacquires the provider's live MCP
schema and runs without tracked local configuration. This is a direct-route
demonstration, not an Agent comparison or compatibility claim for every Math
Anchor release.

## Maintainer-only local pilot

Dependency Preflight exercises Procedure JSONL and short-lived Capability JSONL
behavior in the current development workspace. Structured Data Preflight
exercises the conditional `org.openadam.structured-data.preflight@0.3.0`
Procedure over the current File Vitals and BatchTicket Capability adapters.
Neither Procedure implementation is advertised as an installed or public
integration of this runtime.

Capability HTTP Bridge is a temporary sibling development module queued for
Host source consolidation. Its
maintainer pilot demonstrates that a local Capability JSONL adapter can carry a
typed call across a bounded loopback HTTP endpoint and return through this
runtime. It is not a current public integration, production remote endpoint,
credential-readiness check, or proof that a `local-process` resolution result
means no network egress.

`npm run check:schema-parity` compares bundled compatibility schemas with their
current sibling source without starting a provider. `npm run check:local-pilots`
expects the provider sibling development checkouts. Both are optional
maintainer validation, not part of the ordinary Agent Host installation path.
Generated observations stay in ignored `.verify/` and carry no durable
correctness, capacity, or savings claim. When a required provider checkout is
absent, the local pilot reports that provider route as `not_run` and exits
incomplete; a successful schema-parity subcheck is not promoted into a
provider-pilot PASS.

The Structured Data Preflight branch is an optional development canary inside
that runner. It runs only when `uv`, `file-vitals-capability`, and
`adt-capability` all resolve on Direct Runtime's safe `PATH`. It delegates to
the targeted frozen-artifact check below. The Provider launchers must belong to
artifact roots at their declared `runtime/` paths; Direct Runtime validates the
complete Provider Manifest, selected Capability Profile, contract schemas,
exact plugin/provider/version, operation set, and stage targets before any
Procedure call. The artifact inventory rejects links and special files. When
`component.json` is present, its complete file set, sizes, modes, and digests
are reverified, but this still establishes a Host component artifact rather
than active installation. Missing prerequisites record the branch as `not_run`
in both the detailed observation and final JSON while the main Direct Runtime
pilot continues. Once all prerequisites are present and execution starts, an
incompatible artifact or any targeted-pilot failure fails the whole runner; it
is never downgraded to `not_run`. No adapter is replaced by provider source or
a project virtual environment.

The targeted Structured Data Preflight route is:

```sh
npm run check:structured-data-procedure
```

If the Provider launchers are not already on the Direct Runtime safe `PATH`, set
`OPENADAM_DATA_TRANSFORMER_CAPABILITY` to the absolute packaged
`runtime/adt-capability` launcher and `OPENADAM_FILE_VITALS_CAPABILITY` to the
absolute packaged `runtime/file-vitals-capability` launcher.

It rebuilds the Structured Data Preflight wheel, installs it with its resolved
dependencies into a copied standalone Python 3.11 runtime, and creates one
identity-verified runtime archive. The private Host launch snapshot receives
that archive, a minimal launcher, the wheel, and both exact Provider artifacts;
the launcher expands Python, its standard library, the installed Procedure,
and dependencies only inside that snapshot before execution. A temporary
compatibility manifest changes only the concrete launcher while preserving the
current Procedure identity, Profile digest, exact three stage bindings, and
contract schema digests. This demonstrates execution against those reported
immutable bytes for the named cases without depending on a sibling virtual
environment or source checkout. It does not change the implementation
repository's tracked development manifest, establish a released installation,
or show that an Agent or Agent Host selected the route.

## Resolver boundary

The optional config-backed resolver consumes one exact semantic target and
closed Host constraints. It can return more than one configured provider match,
but counts a provider as exact only when its current binding exposes that exact
Capability operation, Procedure, MCP tool, or projected MCP operation. It does
not enumerate near matches, infer intent, rank providers, or call a target
operation.

An eligible result means only that the named target and requested contract
constraints passed the current deterministic projection route. A configured
Capability or Procedure projection does not start its adapter and therefore
does not observe execution availability. A live MCP projection observes the
contract session, not a successful target call. Provider startup and transport
failures remain `unknown`; they are not converted into semantic rejection.
For a projected MCP operation, a configured projection-envelope match is
reported separately and does not count as an exact candidate until the live
contract exposes that operation identity.
These point-in-time observations do not establish product quality, domain
correctness, future health, credentials, adoption, or substitution fitness.

The resolver returns the exact `openadam.direct-contract-selection.v0.1`
object for each candidate so an Agent or automation can expose only the chosen
task contract through `project`. Provider-owned contracts and semantics remain
outside this package.

## Adding an integration

A provider belongs in the public table only after a current released or
publicly installable boundary has been exercised through this runtime. Record
its public product name, role, repository, stable runtime identity, carrier,
and exact version or contract binding. Being open source alone does not imply
that the provider is supported by this runtime.
