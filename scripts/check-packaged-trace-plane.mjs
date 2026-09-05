#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadProfile } from "../src/profile.mjs";
import { cleanupMaterializedRelease, materializeRelease } from "../src/release-artifacts.mjs";
import { loadReleaseManifest } from "../src/release-manifest.mjs";
import { runFile } from "../src/process.mjs";
import { prepareStatePaths } from "../src/state.mjs";

function usage() {
  return "Usage: node scripts/check-packaged-trace-plane.mjs --release-manifest /absolute/current.json";
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--release-manifest") throw new Error(usage());
  return { releaseManifest: resolve(argv[1]) };
}

async function filesBeneath(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBeneath(candidate));
    else if (entry.isFile()) output.push(candidate);
  }
  return output;
}

const options = parseArguments(process.argv.slice(2));
const temporary = await mkdtemp(join(tmpdir(), "agent-host-packaged-trace-"));
let releasePreparation = null;
try {
  const paths = await prepareStatePaths(join(temporary, "materialized"));
  const release = await loadReleaseManifest(options.releaseManifest);
  const profile = await loadProfile("local-dogfood");
  releasePreparation = await materializeRelease(release, paths, { componentIds: profile.components });
  const observer = releasePreparation.manifest.components["agent-tool-observer"];
  const node = releasePreparation.manifest.components["node-runtime"];
  assert.equal(observer.version, "0.5.0");
  for (const candidate of [observer.root, observer.command, ...observer.args]) {
    assert.equal(candidate.includes("/tools-dev/"), false, `packaged Observer resolves through source: ${candidate}`);
  }

  const home = join(temporary, "home");
  const observerState = join(temporary, "observer-state");
  const codex = join(temporary, "codex");
  const claude = join(temporary, "claude");
  const rollout = join(temporary, "rollout");
  const exportsRoot = join(temporary, "exports");
  for (const directory of [home, codex, claude, rollout, exportsRoot]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const source = join(rollout, "model-io-packaged-check.jsonl");
  const promptMarker = "SELECTED_FIXTURE_PROMPT";
  const credentialMarker = "FIXTURE_TRANSPORT_CREDENTIAL";
  const startedAt = new Date(Date.now() - 1_000);
  const completedAt = new Date(startedAt.getTime() + 25);
  await writeFile(source, `${JSON.stringify({
    type: "model_io",
    sessionId: "packaged-session",
    turnId: "packaged-turn",
    requestId: "packaged-request",
    querySource: "main_turn",
    attempt: 1,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: 25,
    model: { providerId: "fixture", modelId: "fixture-model" },
    request: {
      headers: { authorization: credentialMarker },
      providerOptions: { token: credentialMarker },
      messages: [{ role: "user", content: promptMarker }],
      messageCount: 1,
      toolNames: ["mcp__math_anchor__math_run"]
    },
    response: {
      finishReason: "tool-calls",
      text: "fixture response",
      reasoningText: "fixture rationale",
      headers: { cookie: credentialMarker },
      toolCalls: [{ id: "packaged-call", name: "mcp__math_anchor__math_run", input: { expression: "1+1" } }],
      usage: { inputTokens: 10, cacheReadTokens: 2, outputTokens: 3, totalTokens: 13 }
    },
    error: null
  })}\n`, { mode: 0o600 });

  const environment = {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    HOME: home,
    ATO_STATE_DIR: observerState,
    ATO_NODE_EXECUTABLE: node.command,
    ATO_CODEX_ROOTS: codex,
    ATO_CLAUDE_ROOTS: claude,
    ATO_ZCODE_DB: join(temporary, "missing-zcode.sqlite"),
    ATO_ZCODE_TRACE_ROOTS: rollout,
    ATO_TRACE_BRIDGE_LOGS: [
      join(observerState, "bridges", "deepseek-harness.jsonl"),
      join(observerState, "bridges", "github-copilot-cli.jsonl"),
      join(observerState, "bridges", "claude-hooks.jsonl")
    ].join(delimiter),
    ATO_GEMINI_TELEMETRY_LOGS: join(observerState, "bridges", "gemini-cli-otel.log"),
    ATO_DIRECT_RUNTIME_LOGS: join(temporary, "missing-direct-runtime.jsonl")
  };
  const runObserver = async (argumentsList, input = "") => {
    const result = await runFile(observer.command, [...observer.args, ...argumentsList, "--json"], {
      cwd: observer.root,
      env: environment,
      input,
      timeoutMs: 120_000,
      maxBuffer: 4 * 1024 * 1024
    });
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  };

  const configModule = await import(pathToFileURL(join(observer.root, "src", "config.mjs")));
  const installerModule = await import(pathToFileURL(join(observer.root, "src", "installer.mjs")));
  const config = configModule.resolveConfig(environment, home);
  const installedRuntime = installerModule.copyRuntimeBundle(config);
  const stableLauncher = installerModule.installStableHookLauncher(config, installedRuntime);
  assert.equal(installedRuntime.bundlePath.includes("/tools-dev/"), false);
  assert.equal(stableLauncher.startsWith(observerState), true);

  const catalog = await runObserver(["adapters"]);
  assert.equal(catalog.adapters.length, 7);
  assert.equal(JSON.stringify(catalog).includes(temporary), false);
  const automatic = await runObserver(["adapter-plan", "--adapter", "openadam.zcode-model-io"]);
  const gemini = await runObserver(["adapter-plan", "--adapter", "openadam.gemini-cli-otel"]);
  const claudePlan = await runObserver(["adapter-plan", "--adapter", "openadam.claude-code-hooks"]);
  const copilot = await runObserver(["adapter-plan", "--adapter", "openadam.github-copilot-cli-hooks"]);
  const deepSeek = await runObserver(["adapter-plan", "--adapter", "openadam.deepseek-harness-session-events"]);
  for (const plan of [automatic, gemini, claudePlan, copilot, deepSeek]) assert.equal(plan.appliesChanges, false);
  assert.equal(automatic.configuration.userConfigurationRequired, false);
  assert.equal(gemini.configuration.fragment.telemetry.logPrompts, false);
  assert.equal(
    Object.values(claudePlan.configuration.fragment.hooks)
      .flat()
      .flatMap((group) => group.hooks)
      .every((hook) => hook.async === true),
    true
  );
  assert.equal("preToolUse" in copilot.configuration.document.hooks, false);
  await stat(deepSeek.configuration.module);

  const first = await runObserver(["collect"]);
  const zcodeTrace = first.traceAdapters.find((item) => item.adapterId === "openadam.zcode-model-io");
  assert.equal(zcodeTrace.eventsWritten > 0, true);
  const second = await runObserver(["collect"]);
  assert.equal(second.traceAdapters.find((item) => item.adapterId === "openadam.zcode-model-io").eventsWritten, 0);

  const copilotHook = copilot.configuration.document.hooks.postToolUse[0];
  const hookResult = await runFile(copilotHook.exec, copilotHook.args, {
    env: environment,
    input: JSON.stringify({
      sessionId: "packaged-copilot-session",
      turnId: "packaged-copilot-turn",
      toolCallId: "packaged-copilot-call",
      toolName: "mcp__math_anchor__math_run",
      toolInput: { private: promptMarker },
      toolResponse: { private: credentialMarker },
      success: true,
      timestamp: Date.now()
    }),
    timeoutMs: 2_000
  });
  assert.equal(hookResult.stdout, "");
  assert.equal(hookResult.stderr, "");
  await runObserver(["collect"]);
  const report = await runObserver(["report", "--days", "1"]);
  assert.equal(report.tracePlane.providers.some((item) => item.provider === "zcode"), true);
  assert.equal(report.tracePlane.providers.some((item) => item.provider === "github-copilot-cli"), true);
  assert.equal(report.tracePlane.interpretationStatus, "not-performed");
  assert.equal(report.tracePlane.explicitAnalysisPack.retainedSessionContentPolicy, "metadata-only");
  assert.equal(report.tracePlane.explicitAnalysisPack.retainedSessionSelectedContentAvailable, false);

  const metadataOutput = join(exportsRoot, "metadata.json");
  const selectedOutput = join(exportsRoot, "selected.json");
  const retainedOutput = join(exportsRoot, "retained.json");
  const metadata = await runObserver(["trace-export", "--provider", "zcode", "--file", source, "--output", metadataOutput]);
  const selected = await runObserver([
    "trace-export", "--provider", "zcode", "--file", source, "--output", selectedOutput,
    "--include-selected-content", "--confirm-sensitive-content"
  ]);
  const sources = await runObserver(["trace-sources", "--provider", "zcode", "--limit", "25"]);
  assert.equal(sources.schemaVersion, "openadam.agent-host-trace-source-catalog.v0.1");
  assert.equal(sources.sources.length, 1);
  assert.equal(sources.sources[0].completeness, "unknown");
  const retained = await runObserver([
    "trace-export", "--provider", "zcode", "--session", sources.sources[0].sessionHash,
    "--output", retainedOutput
  ]);
  assert.equal(metadata.contentPolicy, "metadata-only");
  assert.equal(selected.contentPolicy, "selected-content");
  assert.equal(retained.schemaVersion, "openadam.agent-host-trace-analysis-pack.v0.2");
  assert.equal(retained.contentPolicy, "metadata-only");
  const metadataBytes = await readFile(metadataOutput, "utf8");
  const selectedBytes = await readFile(selectedOutput, "utf8");
  const retainedBytes = await readFile(retainedOutput, "utf8");
  const metadataPack = JSON.parse(metadataBytes);
  const selectedPack = JSON.parse(selectedBytes);
  const retainedPack = JSON.parse(retainedBytes);
  assert.equal(metadataPack.privacy.selectedContentMayContainUserSecrets, false);
  assert.equal(selectedPack.privacy.selectedContentMayContainUserSecrets, true);
  assert.equal(metadataBytes.includes(promptMarker), false);
  assert.equal(selectedBytes.includes(promptMarker), true);
  assert.equal(selectedBytes.includes(credentialMarker), false);
  assert.equal(retainedPack.source.selectionKind, "observer-retained-session");
  assert.equal(retainedPack.source.completeness, "unknown");
  assert.equal(retainedPack.privacy.sourceUsesObserverRetainedMetadata, true);
  assert.equal(retainedBytes.includes(promptMarker), false);
  assert.equal(retainedBytes.includes(credentialMarker), false);
  assert.equal(retainedBytes.includes(temporary), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(metadataOutput)).mode & 0o777, 0o600);
    assert.equal((await stat(selectedOutput)).mode & 0o777, 0o600);
    assert.equal((await stat(retainedOutput)).mode & 0o777, 0o600);
  }
  const retainedState = Buffer.concat(await Promise.all((await filesBeneath(observerState)).map((file) => readFile(file)))).toString("utf8");
  assert.equal(retainedState.includes(promptMarker), false);
  assert.equal(retainedState.includes(credentialMarker), false);

  process.stdout.write(`${JSON.stringify({
    status: "ok",
    releaseId: releasePreparation.manifest.releaseId,
    observerVersion: observer.version,
    adapterCount: catalog.adapters.length,
    zcodeWrites: zcodeTrace.eventsWritten,
    settledWrites: 0,
    hookOnlyProviderVisible: true,
    metadataPackEvents: metadata.eventsReturned,
    selectedPackEvents: selected.eventsReturned,
    retainedPackEvents: retained.eventsReturned,
    retainedSessionEnumeration: true,
    selectedContentExplicit: true,
    credentialContentRetained: false,
    observerStateContentRetained: false,
    sourceCheckoutDependency: false,
    agentShellConfigurationChanged: false
  })}\n`);
} finally {
  if (releasePreparation !== null) await cleanupMaterializedRelease(releasePreparation);
  await rm(temporary, { recursive: true, force: true });
}
