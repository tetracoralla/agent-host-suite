import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../src/config.mjs";
import { openStateDatabase } from "../src/db.mjs";
import { schemaColumns } from "../src/db-read.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(candidate);
    return entry.isFile() && candidate.endsWith(".mjs") ? [candidate] : [];
  });
}

const forbiddenNetworkImports = [
  "node:http",
  "node:https",
  "node:http2",
  "node:net",
  "node:tls",
  "node:dgram",
  "node:dns"
];

const executableRoots = [path.join(repoRoot, "src"), path.join(repoRoot, "integrations")];
for (const file of executableRoots.flatMap((directory) => sourceFiles(directory))) {
  const source = fs.readFileSync(file, "utf8");
  for (const forbidden of forbiddenNetworkImports) {
    assert.equal(source.includes(forbidden), false, `${path.relative(repoRoot, file)} imports ${forbidden}`);
  }
  assert.doesNotMatch(source, /\beval\s*\(/, `${path.relative(repoRoot, file)} uses eval`);
  assert.doesNotMatch(source, /\bnew\s+Function\b/, `${path.relative(repoRoot, file)} uses Function construction`);
}

const providerMutationPattern = /\b(?:writeFile|appendFile|rename|unlink|rm|mkdir|chmod|chown|truncate)(?:Sync)?\b/;
for (const file of sourceFiles(path.join(repoRoot, "src", "providers"))) {
  const source = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(source, providerMutationPattern, `${path.relative(repoRoot, file)} contains a provider-source mutation primitive`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
assert.deepEqual(packageJson.dependencies ?? {}, {}, "runtime dependencies must remain empty");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tool-observer-contract-"));
try {
  const config = resolveConfig({ ATO_STATE_DIR: path.join(temporary, "state") }, path.join(temporary, "home"));
  const database = openStateDatabase(config);
  const forbiddenColumns = new Set([
    "prompt",
    "message",
    "reasoning",
    "path",
    "command",
    "arguments",
    "input_content",
    "result",
    "output_content",
    "error_message",
    "raw"
  ]);
  const violations = schemaColumns(database).filter((column) => forbiddenColumns.has(column.name));
  assert.deepEqual(violations, [], "persisted schema contains raw-content fields");
  database.close();
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write("contract checks: ok\n");
