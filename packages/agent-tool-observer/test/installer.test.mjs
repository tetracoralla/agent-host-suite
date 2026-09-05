import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixtureConfig, temporaryRoot } from "./helpers.mjs";
import { copyRuntimeBundle, installLaunchAgent, installStableHookLauncher, prepareOwnerLogFiles, purgeStateDirectory, renderLaunchAgent, resolveStableNodePath, runtimeInventory } from "../src/installer.mjs";

test("LaunchAgent runs one fixed short-lived collector without KeepAlive or shell", () => {
  const plist = renderLaunchAgent({
    nodePath: "/safe/node&binary",
    cliPath: "/safe/observer<cli>.mjs",
    stdoutPath: "/safe/out.log",
    stderrPath: "/safe/err.log",
    directRuntimeLogs: ["/private/runtime/observations.jsonl"]
  });
  assert.match(plist, /<key>StartInterval<\/key>/);
  assert.match(plist, /<integer>300<\/integer>/);
  assert.doesNotMatch(plist, /KeepAlive/);
  assert.doesNotMatch(plist, /\/bin\/(?:ba|z)?sh/);
  assert.doesNotMatch(plist, /kickstart/);
  assert.match(plist, /<string>--quiet<\/string>/);
  assert.doesNotMatch(plist, /<string>--json<\/string>/);
  assert.match(plist, /node&amp;binary/);
  assert.match(plist, /observer&lt;cli&gt;/);
  assert.match(plist, /ATO_DIRECT_RUNTIME_LOGS/);
  assert.match(plist, /\/private\/runtime\/observations\.jsonl/);
});

test("install dry-run performs no filesystem mutation", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const fakeHome = `${root}/not-created-home`;
    const result = installLaunchAgent(config, { dryRun: true, homeDirectory: fakeHome });
    assert.equal(result.status, "dry-run");
    assert.equal(fs.existsSync(fakeHome), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit release Node is selected without falling back to a machine installation", () => {
  const root = temporaryRoot();
  try {
    const nodePath = path.join(root, "release-node");
    fs.writeFileSync(nodePath, "release node", { mode: 0o700 });
    assert.equal(resolveStableNodePath(nodePath), path.resolve(nodePath));
    assert.throws(() => resolveStableNodePath(path.join(root, "missing-node")), { code: "NODE_EXECUTABLE_INVALID" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LaunchAgent log preparation repairs modes and rejects symlink targets", () => {
  const root = temporaryRoot();
  try {
    const stdoutPath = path.join(root, "stdout.log");
    const stderrPath = path.join(root, "stderr.log");
    fs.writeFileSync(stdoutPath, "existing", { mode: 0o644 });
    prepareOwnerLogFiles({ stdoutPath, stderrPath });
    assert.equal(fs.lstatSync(stdoutPath).mode & 0o777, 0o600);
    assert.equal(fs.lstatSync(stderrPath).mode & 0o777, 0o600);

    fs.unlinkSync(stderrPath);
    fs.symlinkSync(stdoutPath, stderrPath);
    assert.throws(() => prepareOwnerLogFiles({ stdoutPath, stderrPath }), { code: "LOG_TARGET_INVALID" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("content-addressed installation keeps a fixed runtime when source later changes", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const source = path.join(root, "runtime-source");
    fs.mkdirSync(path.join(source, "src"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: "1.2.3" }), { mode: 0o600 });
    fs.writeFileSync(path.join(source, "src", "cli.mjs"), "export const value = 1;\n", { mode: 0o600 });
    const first = copyRuntimeBundle(config, { sourceRoot: source });
    assert.equal(fs.readFileSync(first.cliPath, "utf8"), "export const value = 1;\n");

    fs.writeFileSync(path.join(source, "src", "cli.mjs"), "export const value = 2;\n", { mode: 0o600 });
    const second = copyRuntimeBundle(config, { sourceRoot: source });
    assert.notEqual(first.digest, second.digest);
    assert.notEqual(first.bundlePath, second.bundlePath);
    assert.equal(fs.readFileSync(first.cliPath, "utf8"), "export const value = 1;\n");
    assert.equal(fs.readFileSync(second.cliPath, "utf8"), "export const value = 2;\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installed runtime inventory carries adapter contracts and shell integration packages", () => {
  const inventory = runtimeInventory();
  assert.equal(inventory.includes("adapters/zcode-model-io.json"), true);
  assert.equal(inventory.includes("integrations/deepseek-harness/index.mjs"), true);
  assert.equal(inventory.includes("integrations/deepseek-harness/package.json"), true);
  assert.equal(inventory.includes("integrations/deepseek-harness/README.md"), true);
});

test("stable hook launcher follows the current immutable Observer runtime", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    const source = path.join(root, "runtime-source");
    fs.mkdirSync(path.join(source, "src"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: "1.2.3" }), { mode: 0o600 });
    fs.writeFileSync(path.join(source, "src", "cli.mjs"), "export {};\n", { mode: 0o600 });
    fs.writeFileSync(path.join(source, "src", "hook-cli.mjs"), "export async function main() { return 0; }\n", { mode: 0o600 });
    const first = copyRuntimeBundle(config, { sourceRoot: source });
    const launcher = installStableHookLauncher(config, first);
    assert.match(fs.readFileSync(launcher, "utf8"), new RegExp(first.digest, "u"));
    fs.writeFileSync(path.join(source, "src", "hook-cli.mjs"), "export async function main() { return 1; }\n", { mode: 0o600 });
    const second = copyRuntimeBundle(config, { sourceRoot: source });
    installStableHookLauncher(config, second);
    const contents = fs.readFileSync(launcher, "utf8");
    assert.match(contents, new RegExp(second.digest, "u"));
    assert.doesNotMatch(contents, new RegExp(first.digest, "u"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit purge removes only the resolved real state directory", () => {
  const root = temporaryRoot();
  try {
    const { config } = fixtureConfig(root);
    fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(config.stateDir, "observation.txt"), "metadata", { mode: 0o600 });
    const result = purgeStateDirectory(config);
    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(config.stateDir), false);

    const target = path.join(root, "target");
    const linked = path.join(root, "linked-state");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, linked);
    assert.throws(() => purgeStateDirectory({ ...config, stateDir: linked }), { code: "PURGE_STATE_DIR_UNSAFE" });
    assert.equal(fs.existsSync(target), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
