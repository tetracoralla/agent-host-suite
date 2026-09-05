import { readFile } from "node:fs/promises";
import { executeAnalyze, executeDiff } from "../src/core.js";
import { errorResult } from "../src/errors.js";
import { callTool } from "../src/mcp-server.js";
import { createUiServer } from "../src/ui-server.js";

const [before, after] = await Promise.all([
  readFile("examples/baseline.json", "utf8"),
  readFile("examples/updated.json", "utf8")
]);
const analysis = executeAnalyze(before);
const diff = executeDiff(before, after);
const mcp = callTool("context.analyze", { snapshot_json: before });
const invalidMcp = callTool("context.analyze", { snapshot_json: "{" });

const server = createUiServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const homepage = await fetch(`http://127.0.0.1:${address.port}/`);
const invalidResponse = await fetch(`http://127.0.0.1:${address.port}/api/analyze`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ snapshotJson: "{" })
});
const invalidWeb = await invalidResponse.json();
await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

if (
  analysis.result.status !== "ok" ||
  diff.result.status !== "ok" ||
  mcp.isError ||
  !invalidMcp.isError ||
  !homepage.ok ||
  invalidWeb.error?.code !== "INVALID_JSON"
) {
  throw new Error(JSON.stringify(errorResult(new Error("Smoke assertion failed."))));
}

process.stdout.write(`${JSON.stringify({
  status: "ok",
  cliCoreAnalyze: analysis.result.counts,
  cliCoreDiff: diff.result.deltas,
  mcpHappy: !mcp.isError,
  mcpInvalidCode: invalidMcp.structuredContent.error.code,
  webHomepage: homepage.status,
  webInvalidCode: invalidWeb.error.code
})}\n`);
