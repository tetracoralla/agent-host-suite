# Featured profile and tool browsing

A featured catalog is an owner-selected, version-locked subset of independently
released Agent tools that already have a closed tool-integration record in a
**bound** compatibility release. It is a Host admission list, not a public marketplace,
store, ranking, review, payment, or third-party plugin index.

The bundled installation route is the named `featured` profile plus `profiles list` /
`setup --profile featured` / `update --profile featured` over the installation
APIs that already exist. Browser and native Managers use those same APIs for the featured bundle.
Their Browse pages also read `tools browse`: individually admitted GitHub
plugins use their own preview and install action, rather than reinstalling the
featured bundle. The browseable inventory is not limited to that default bundle.
`tools set --profile` only selects the working set of **already installed**
tools; it does not fetch Armorial or other missing inventory.

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
- Compact product rows in setup and Tools that use the upstream product mark,
  one short job label, current availability, and a direct **Use** action. The
  editable example is handed off after that action. These are optional
  invitations, not ratings, requirements, portable provider metadata, or proof
  of value.

v1 search filters the compatible catalog already known to Host. It is not
featured-placement scoring, ratings, a universal public registry, or a promise
that a repository is compatible merely because it exists. A GitHub URL must
pass compatibility preview before **Add** becomes available. It also does not
promise that a selected tool is loaded in an already open session.

## Distributing a bound installation

The unsigned preview route uses a macOS DMG or Windows ZIP from a published
GitHub Release or a self-hosted HTTPS URL, as documented in
[`UNSIGNED_PREVIEW.md`](UNSIGNED_PREVIEW.md). A source checkout is not evidence
that an external download is available. Host resolves the configured published
index and reports when a compatible download is unavailable.

Obtain a **bound** compatibility catalog (manifest, artifacts, and
`build-provenance.json`) from that Release index or another owner-issued
preview. Point setup at that catalog, or set `AGENT_HOST_FEATURED_CATALOG_URL`
so Manager and CLI can fetch it. A featured list in prose cannot substitute for
those bytes.

```text
agent-host profiles list --json
export AGENT_HOST_FEATURED_CATALOG_URL=https://example.invalid/preview-distribution.json
agent-host profiles fetch --json
agent-host setup --profile featured --host zcode --release-manifest /absolute/current.json
agent-host setup --profile featured --no-host --release-manifest /absolute/current.json
agent-host update --profile featured --release-manifest /absolute/current.json
agent-host tools set --profile featured
agent-host tools set --tool math-anchor --tool armorial
agent-host doctor --deep --json
agent-host source status --json
agent-host source check --json
agent-host source set --release-manifest /absolute/current.json
```

Unsigned macOS downloads are not Apple-notarized, and this product does not
ship Developer ID signed or App Store builds. Try to open the app; if Gatekeeper
blocks it, open System Settings → Privacy & Security and choose Open Anyway.
That warning is expected for this preview. On macOS 14, Control-click → Open
may still work; it does not on macOS 15 Sequoia and later. Configure Host with
`AGENT_HOST_FEATURED_CATALOG_URL` pointing at
`preview-distribution.json` or a bound `current.json`; this checkout does not
claim that URL is live.

`setup` against this repository's tracked `catalog/releases/draft-unbound`
fails closed. `--development-root` is the tools-dev path (`local-dogfood`),
not featured.

| Intent | Existing API |
| --- | --- |
| List admitted profiles and the featured set | `agent-host profiles list` (`catalog/profiles/*.json`) |
| Choose the admitted inventory | `setup --profile featured` / `update --profile featured` |
| Bind exact bytes | bound release catalog + `build-provenance.json`; `setup` / `update --release-manifest`; or `profiles fetch` / `AGENT_HOST_FEATURED_CATALOG_URL` |
| Select the working set after install | `agent-host tools set --profile featured` or `tools set --tool …` / Manager working-set toggles. This is not inventory install. |
| Get uninstalled featured tools in Manager | native and browser Tools **Get featured tools** call `update --profile featured` |
| Install Host first, connect Agent later | `setup --no-host`, then `host add` after a supported app is detected |
| Add one extra owner-selected archive | `component preview` then `component import` (inactive until `--activate` or `tools set`) |
| Connect an Agent app | `host add` / setup `--host`, public marketplace/plugin/MCP/Skill extension points only |
| Verify projection vs live binding | `doctor --deep` without `--skip-agent-apps`; `host status` without `--quick` |
| Application build, environment release, tool versions, and catalog source | `agent-host source status` / Manager Settings. Distinguishes the Manager app from the installed environment. Catalog assets are unpublished until an owner publishes a Release or an HTTPS index. |
| Choose a local or HTTPS catalog | `source set --release-manifest` / `source set --url`, or Manager Settings. Env `AGENT_HOST_FEATURED_CATALOG_URL` still works. Interrupted, offline, and digest errors keep a retry or local-catalog recovery. This does not publish a GitHub Release. |
| User-level task readiness (tools, connection, projection; not adoption) | `doctor --featured-readiness` overall `status` / `userStatus`. Recipe name is a separate `recipe.consistency` check. `local-dogfood` plus a healthy Armorial projection is not a user-level failure. |
| Featured recipe consistency | `recipe.consistency` on the same report records the working set as an experimental variable. It is context for an optional exercise, not a scoring gate, and does not require deleting other healthy tools. |
| Recognize and try an admitted tool | native and browser product rows show its mark and availability, then **Use** can copy one editable example and open a connected Agent app; this records no adoption or quality verdict |
| Observe session discovery | a **new** Agent task after `restartRequired` |

If local monitoring is already enabled, `update --profile featured` keeps the
consented monitoring components when the bound release contains them. A bound
release that omits those components fails closed before writing and does not
turn monitoring off. Tool selection and monitoring remain separate.

Managers present the same featured admission list: choose `featured` at setup,
or Get featured tools after a Standard install. The default page lists local
inventory first and recommendations second; **Browse** searches the compatible
catalog and exposes the compatibility-gated GitHub path. Product rows lead with
what the tool is, whether it is available, and one action that hands an editable
example to a new Agent task. This does not add ranking or payment flows.

Provider and contributor routes are documented in
[`ECOSYSTEM_PATHS.md`](ECOSYSTEM_PATHS.md). Those routes meet at exact artifact
admission; they do not force every provider into one Host-owned product model.

tools-dev dogfood is a different audience: `docs/LOCAL_DOGFOOD.md`, profile
`local-dogfood`, and sibling checkouts as **build inputs**. Those paths are
not the external-user install and must not be described as a store.

## Discovery after install

Install and Host selection are not session discovery. After a featured tool is
in the working set:

1. Host materializes the Agent-app projection (Codex: content-addressed plugin
   plus public `plugin add`; Claude/ZCode: public MCP/Skill links).
2. The Agent app must start a **fresh** task to load Skill and MCP catalogs.
3. Natural use on a suitable task (for example Armorial for icon work) remains
   Agent choice. Host status, doctor, and observation counts do not establish
   why it was chosen or whether it helped.

See [`DISCOVERY_PROJECTION.md`](DISCOVERY_PROJECTION.md) for the Codex cache
generations and the Host vs session honesty boundary. Optional unnamed page
situations, copy-out fixtures, and a Host-only readiness probe are in
[`ADOPTION_ACCEPTANCE.md`](ADOPTION_ACCEPTANCE.md). The participant decides
what a live exercise means; this checkout does not claim one was completed.

## Non-goals for v1

- Host-owned generic `invoke provider` tool.
- Patching Codex, Claude Code, ZCode, or another Agent app.
- Claiming Apple notarization, Developer ID signing, or an App Store listing.
- Treating GitHub Releases as already populated when this checkout has no assets.
- Publishing a third-party plugin marketplace from this document.
- Treating `local-dogfood` membership as an external featured set.
- A Manager marketplace UI, ranking, reviews, or payments. Featured browse/get
  in Manager is the owner-selected admission list, not a store.
