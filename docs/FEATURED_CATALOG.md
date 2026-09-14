# Featured catalog v1

A featured catalog is an owner-selected, version-locked subset of independently
released Agent tools that already have a closed tool-integration record in a
**bound** compatibility release. It is a Host admission list, not a public marketplace,
store, ranking, review, payment, or third-party plugin index.

This source checkout does not operate a catalog service and does not ship a
browseable store. v1 is the named `featured` profile plus `profiles list` /
`tools set --profile` over the installation APIs that already exist.

## What v1 is

- Profile `featured` in `catalog/profiles/featured.json`. It extends `standard`
  and admits Armorial. Exact membership is that JSON file plus the selected
  bound release, not this paragraph.
- The documented default working set is the profile's `defaultAgentComponents`
  (Math Anchor, Migratory Time, and Armorial). That set is not `local-dogfood`.
- A private overlay of extra sealed archives through
  `agent-host component preview` / `component import`, inactive by default.
- Human copy that names the independently released product (Armorial, Math
  Anchor, and so on) and the Host action that installs or selects it.

v1 is not: search, featured placement scores, screenshots, ratings, a public
plugin registry, an Agent-facing import prompt, or a promise that a selected
tool is loaded in an already open session.

## External path without a public Release

This checkout has no public GitHub Release and no notarized DMG. Obtain a
**bound** compatibility catalog (manifest, artifacts, and
`build-provenance.json`) from an owner-issued internal or preview distribution.
Point setup at that catalog. A featured list in prose cannot substitute for
those bytes.

```text
agent-host profiles list --json
agent-host setup --profile featured --host zcode --release-manifest /absolute/current.json
agent-host tools set --profile featured
agent-host tools set --tool math-anchor --tool armorial
agent-host doctor --deep --json
```

`setup` against this repository's tracked `catalog/releases/draft-unbound`
fails closed. `--development-root` is the tools-dev path (`local-dogfood`),
not featured.

| Intent | Existing API |
| --- | --- |
| List admitted profiles and the featured set | `agent-host profiles list` (`catalog/profiles/*.json`) |
| Choose the admitted inventory | `setup --profile featured` / `update --profile featured` |
| Bind exact bytes | bound release catalog + `build-provenance.json`; `setup` / `update --release-manifest` |
| Select the working set after install | `agent-host tools set --profile featured` or `tools set --tool …` / Manager tool toggles |
| Add one extra owner-selected archive | `component preview` then `component import` (inactive until `--activate` or `tools set`) |
| Connect an Agent app | `host add` / setup `--host`, public marketplace/plugin/MCP/Skill extension points only |
| Verify projection vs live binding | `doctor --deep` without `--skip-agent-apps`; `host status` without `--quick` |
| Featured working set + projection receipts (not adoption) | `doctor --featured-readiness` |
| Observe session discovery | a **new** Agent task after `restartRequired` |

If local monitoring is already enabled, `update --profile featured` keeps the
consented monitoring components when the bound release contains them. A bound
release that omits those components fails closed before writing and does not
turn monitoring off. Tool selection and monitoring remain separate; this is
not a GUI install path.

tools-dev dogfood is a different audience: `docs/LOCAL_DOGFOOD.md`, profile
`local-dogfood`, and sibling checkouts as **build inputs**. Those paths are
not the external-user install and must not be described as a store.

## Discovery after install

Install and Host selection are not session discovery. After a featured tool is
in the working set:

1. Host materializes the Agent-app projection (Codex: content-addressed plugin
   plus public `plugin add`; Claude/ZCode: public MCP/Skill links).
2. The Agent app must start a **fresh** task to load Skill and MCP catalogs.
3. Natural adoption on a suitable task (for example Armorial for icon work)
   remains Agent judgment. Host status, doctor, and observation counts do not
   establish adoption.

See [`DISCOVERY_PROJECTION.md`](DISCOVERY_PROJECTION.md) for the Codex cache
generations and the Host vs session honesty boundary. Unnamed page tasks,
copy-out fixtures, and a Host-only readiness probe are in
[`ADOPTION_ACCEPTANCE.md`](ADOPTION_ACCEPTANCE.md). That protocol is for a
machine with Host plus Agent; this checkout does not record a completed live
adoption.

## Non-goals for v1

- Host-owned generic `invoke provider` tool.
- Patching Codex, Claude Code, ZCode, or another Agent app.
- Publishing a notarized DMG, GitHub Release, or public marketplace from this
  document.
- Treating `local-dogfood` membership as an external featured set.
- A Manager marketplace UI.
