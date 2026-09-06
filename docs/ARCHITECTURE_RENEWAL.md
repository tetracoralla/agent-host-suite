# Agent Host 0.2 architecture and migration

Agent Host 0.2 consolidates Provider integration and makes environment changes
recoverable across process interruption. Public Capability and Procedure
semantics remain unchanged.

## Provider integration

Generic runtime configuration, materialization, and diagnostics consume one
normalized Provider binding. Product-specific pilot adapters translate existing
Math Anchor and Migratory Time artifacts at their boundary. Adding a supported
binding no longer requires product branches in generic configuration or doctor.

MCP admission requires an input schema and validates an output schema when the
Provider advertises one. Omitted output schemas remain omitted. Exact typed
schema-pair export retains its stricter contract. Catalog byte and tool limits
bound resources; they do not measure model input or token savings.

## Environment recovery

A lifecycle lease serializes changes to one environment. Before an external
effect, the environment journal records the resource identity and its before
and after values. The state file points to the unfinished change until the new
state commits. A subsequent authorized mutation recovers interrupted work.

The journal covers owned JSON fields, Skill links, moved projections, native
Codex registrations, and macOS or Windows services. Recovery checks all remaining
resources before restoring any of them and checks again before each effect.
Conflicting user edits are preserved and require intervention. Deleting an
already-withdrawn configuration does not cause recovery to recreate it.

This is recoverable coordination, not an atomic transaction across applications
and operating-system services. A native resource whose prior state cannot be
reproduced blocks replacement. Historical service recovery bundles retain their
reader and recovery command; new service changes use the environment journal.

## Updating an existing installation

1. Build and verify the compatible 0.2 Manager application, including its bundled
   CLI, against both the existing state and a proposed v0.2 state.
2. Replace the Manager through the platform installation route while retaining
   the prior application and environment recovery data.
3. Run the new packaged CLI update preview against the chosen compatibility
   catalog. Preserve the current active tools, private components, host
   connections, workspace grants, and monitoring preference.
4. Apply the update, then verify packaged status, deep health, service readiness,
   host bindings, and the Manager's rendered environment view.

New state commits use `openadam.agent-host-state.v0.2`. Reading a legacy v0.1
record does not rewrite it. The first committed migration retains the old
ownership record in history. Failed changes restore the previous record.
The updater asks the installed application to read the exact proposed state
before changing hosts, services, or saved state. An incompatible application
blocks the transition; editing the schema marker is not a migration method.

Keep the compatible Manager when rolling back the tool environment. The old
Manager cannot read v0.2 ownership records, even when the selected tool release
is older. Restoring the old application requires restoring its corresponding
pre-migration environment through a verified recovery procedure.

## Evaluation and measured limits

Natural four-route evaluation belongs to the separate private evaluation
workspace. Its Controller compares native host, direct Provider, baseline Host,
and candidate Host under declared runtime identities and budgets. Each Host arm
has its own state and operations launcher. No evaluation service or model call
is added to ordinary Agent Host operation.

The old forced-tool experiment and implicit model choice have been removed.
The existing launch snapshot remains: attempted replacements failed either
performance comparisons or actual dependency loading. No snapshot optimization,
model-utility improvement, token reduction, or natural-adoption result is claimed.

Source checks and isolated macOS flows cover Provider execution, native host
ownership, state migration, interruption, recovery, and packaged CLI behavior.
Windows protocol and hosted checks remain distinct from a physical Windows
installation, Task Scheduler, login, reboot, and user-experience assessment.
Platform distribution requirements are in [RELEASE.md](RELEASE.md); lifecycle
and ownership details are in [ARCHITECTURE.md](ARCHITECTURE.md).
