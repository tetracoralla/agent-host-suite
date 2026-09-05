# Windows installation and lifecycle

[English](WINDOWS.md) · [简体中文](WINDOWS.zh-CN.md)

## What the package is

The Windows distribution is one ZIP for the current user. It contains the
Agent Host management application, a private Node.js runtime, the selected
immutable tool and Developer Kit artifacts, every required license and notice,
and a payload manifest with the exact size and SHA-256 of every installed file.
It does not require a source checkout, Git, npm, administrator access, or a
system service.

The current engineering carrier is unsigned. A public download therefore
needs an Authenticode signing decision and a clean-device SmartScreen run in
addition to the lifecycle checks below. Apple Developer identity and DMG work
do not affect this Windows carrier.

## Install

1. Compare the downloaded ZIP with its adjacent `SHA256SUMS` file.
2. Extract the complete ZIP.
3. Open `Install Agent Host.cmd`.
4. Open **Agent Host** from the Start menu, choose ZCode, Codex, or Claude
   Code, and select Standard tools, Developer Kit, or Standard + monitoring.

The installer verifies the extracted payload before and after copying it. It
installs beneath `%LOCALAPPDATA%\Programs\openAdam\Agent Host`, adds only its
`bin` directory to the current user's `PATH`, creates shortcuts beneath the
current user's openAdam Start menu folder, and retains at most one previous
application for restore. Agent tools, settings, observations, and rollback
packages remain in their separately owned local state folders.

For an unattended or isolated installation:

```powershell
& '.\Install-AgentHost.ps1' -NoLaunch -NoShortcuts -NoPath
```

`-InstallRoot` may select one explicit test location. The installer rejects a
drive root or another dangerously broad path.

## Use and monitor

The Start menu shortcut opens a short-lived management server bound only to
`127.0.0.1` and then opens its one-session authenticated URL in the default
browser. It exposes no network listener, cloud account, raw prompts, tool
arguments, results, or source paths.

The Manager follows the Windows language on first use. A secondary Settings
entry at the bottom of the sidebar lets the user persist English, Simplified
Chinese, or System default without adding language controls to the primary
workflow.

The **Usage & Reliability** view keeps each Agent provider separate and can
show, when that provider exposes the data:

- provider-reported Token totals and peak observed UTC day;
- observed sessions, turns, active days, and current/longest active-day streak;
- a bounded 30-day activity strip;
- most-used mapped Agent Host tools;
- completed, error, cancelled, latency, and Direct Runtime execution counts;
- collector health, freshness, and partial or missing provider coverage.

Codex Token records are cumulative session rollups grouped by the UTC day on
which the rollup was observed; they are not exact incremental daily
consumption. A longest observed session span is metadata elapsed time, not chat
duration. Passive monitoring cannot establish authoritative Skill activation,
why an Agent did not call a tool, semantic effect, result adoption,
correctness, task quality, or value. The user's selected Agent may analyze the
bounded result while preserving those unknowns.

The local Direct Runtime uses a per-install Windows named pipe. Runtime,
Observer, and weekly maintenance use current-user Task Scheduler entries under
`\openAdam`; no administrator privilege or machine-wide service is required.

## Update and restore

**Update tools** and **Restore previous tools** in the Manager change the
immutable Agent environment and its provider packages. Installing a newer ZIP
updates the management application itself and retains the immediately previous
application. **Restore previous Agent Host** in the Start menu swaps the two
verified application versions without changing tools or observations.

Each Agent-app binding change requires a fresh Agent task before the new tool
catalog is expected to appear.

If a Direct Runtime scheduled-task replacement and its automatic rollback both
fail, use the structured `agent-host service recover --recovery ID
--manifest-sha256 SHA256` action returned by the error. The command accepts no
bundle path, runs under the Host lifecycle lock, and restores only when the
selected private state, current launcher and Task XML still match the recorded
failure. A stale, changed, tampered, wrong-digest, or unknown reference is left
untouched for owner intervention.

## Uninstall

Use **Uninstall Agent Host** in the Start menu. The default removes the
application, scheduled entries, Suite-owned Agent-app bindings, installed tool
packages, shortcuts, and `PATH` entry while retaining local Agent Host history,
settings, and Observer observations for reinstall.

To also remove Agent Host's private Suite state:

```powershell
& "$env:LOCALAPPDATA\Programs\openAdam\Agent Host\Uninstall-AgentHost.ps1" -PurgeData
```

Observer's separately owned local database remains preserved. Deleting that
history requires Observer's own explicit purge; Agent Host never guesses that
the user wants pre-existing observations erased.

## Maintainer build

The build must run on Windows so the payload contains a genuine Windows Node
runtime. It also requires one bound release catalog containing exact Windows
artifacts for Standard, observability, and Developer Kit profiles:

```powershell
$env:AGENT_HOST_RELEASE_CATALOG = 'C:\absolute\release-catalog'
npm run package:windows
```

The catalog must include a valid `build-provenance.json` whose policy is
`remote-tagged`. Each source entry must match a clean checkout, a full commit
SHA, and an immutable tag currently resolving from its declared HTTPS remote.
The resulting payload and ZIP distribution manifests retain the provenance
policy and digest. A local-source packaging override is reserved for the CI
fixture and does not produce a public compatibility release.

Output is written to `.build\windows\distribution`. The tracked catalog is
deliberately unbound, so this command fails closed until actual Windows
provider artifacts, licenses, SBOMs, and digests are supplied. The CI workflow
uses deterministic fixture components only to check the packaging and
source-independent lifecycle; it is not a public compatibility release.
