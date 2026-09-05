import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { PassThrough } from "node:stream";
import { LIMITS } from "../src/constants.js";
import { callTool, handleMessage, serializeMessage, startMcpServer } from "../src/mcp-server.js";

async function runStdioExchange(input, expectedResponses) {
  const child = spawn(process.execPath, ["src/mcp-server.js"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const responses = [];
  let buffer = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP responses: ${stderr}`)), 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) responses.push(JSON.parse(line));
        if (responses.length === expectedResponses) {
          clearTimeout(timer);
          resolve();
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (responses.length < expectedResponses) {
        clearTimeout(timer);
        reject(new Error(`MCP exited ${code}/${signal} after ${responses.length} responses: ${stderr}`));
      }
    });
  });
  child.stdin.end(input);
  try {
    await done;
    return responses;
  } finally {
    child.kill();
  }
}

test("MCP initialization negotiates current and supported legacy protocol versions", () => {
  const current = handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25" }
  });
  const legacy = handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" }
  });
  const unknown = handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "initialize",
    params: { protocolVersion: "future-unknown" }
  });
  const modernProbe = handleMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "server/discover",
    params: {}
  });
  assert.equal(current.result.protocolVersion, "2025-11-25");
  assert.equal(legacy.result.protocolVersion, "2025-03-26");
  assert.equal(unknown.result.protocolVersion, "2025-11-25");
  assert.equal(modernProbe.error.code, -32601);
});

test("MCP rejects malformed JSON-RPC envelopes and bounds response serialization", () => {
  assert.equal(handleMessage({ id: 1, method: "ping" }).error.code, -32600);
  assert.equal(handleMessage({ jsonrpc: "2.0", id: { nested: true }, method: "ping" }).error.code, -32600);
  assert.equal(handleMessage({ jsonrpc: "2.0", id: null, method: "ping" }).error.code, -32600);
  assert.equal(handleMessage({
    jsonrpc: "2.0",
    id: "x".repeat(LIMITS.maxJsonRpcIdBytes + 1),
    method: "ping"
  }).error.code, -32600);
  assert.equal(handleMessage({ jsonrpc: "2.0", id: 1, method: "notifications/initialized" }).error.code, -32600);
  assert.equal(handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), null);

  const serialized = serializeMessage({
    jsonrpc: "2.0",
    id: "x".repeat(LIMITS.maxMcpResponseBytes),
    result: {}
  });
  assert.ok(Buffer.byteLength(serialized) <= LIMITS.maxMcpResponseBytes);
  assert.equal(JSON.parse(serialized).error.code, -32603);
});

test("actual stdio MCP rejects a deeply nested id and handles a later ping", async () => {
  const depth = 20_000;
  const nestedId = `${"[".repeat(depth)}0${"]".repeat(depth)}`;
  const input = [
    `{"jsonrpc":"2.0","id":${nestedId},"method":"ping"}`,
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })
  ].join("\n") + "\n";
  const responses = await runStdioExchange(input, 2);
  assert.equal(responses[0].error.code, -32600);
  assert.deepEqual(responses[1], { jsonrpc: "2.0", id: 2, result: {} });
});

test("actual stdio MCP discards one oversized line and recovers on the same connection", async () => {
  const input = `${"x".repeat(LIMITS.maxMcpRequestBytes + 1)}\n${JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "ping"
  })}\n`;
  const responses = await runStdioExchange(input, 2);
  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses[0].error.message, "Message too large");
  assert.deepEqual(responses[1], { jsonrpc: "2.0", id: 3, result: {} });
});

test("MCP pauses request consumption while a slow output is backpressured", async () => {
  const input = new PassThrough();
  const output = new PassThrough({ highWaterMark: 1 });
  startMcpServer(input, output);

  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" })}\n`);
  assert.equal(input.isPaused(), true);

  const drained = once(output, "drain");
  output.resume();
  await drained;
  assert.equal(input.isPaused(), false);
  input.end();
  output.end();
});

test("MCP enforces its complete payload budget", async () => {
  const snapshot = await readFile("examples/baseline.json", "utf8");
  const result = callTool("context.analyze", { snapshot_json: snapshot, max_output_bytes: 256 });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "RESULT_BUDGET_EXCEEDED");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 256);
});

test("MCP bounds wide unknown-field errors without echoing field names", () => {
  const args = { snapshot_json: "{}", max_output_bytes: 256 };
  for (let index = 0; index < 5000; index += 1) args[`invented_${index}`] = index;
  const result = callTool("context.analyze", args);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "UNKNOWN_FIELD");
  assert.equal(result.structuredContent.error.details.fieldCount, 5000);
  assert.equal("fields" in result.structuredContent.error.details, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 256);
});

test("MCP preserves a snapshot validation code at the minimum output budget", () => {
  const snapshot = JSON.stringify({
    format: "context-surface.snapshot.v0.1",
    source: { id: "unknown-field" },
    tools: [],
    invented: true
  });
  const result = callTool("context.analyze", { snapshot_json: snapshot, max_output_bytes: 256 });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "UNKNOWN_FIELD");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 256);
});

test("actual stdio MCP lifecycle exposes closed read-only tools and recovers after invalid input", async (t) => {
  const snapshot = await readFile("examples/baseline.json", "utf8");
  const child = spawn(process.execPath, ["src/mcp-server.js"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => child.kill());

  const responses = [];
  let buffer = "";
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for MCP responses.")), 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) responses.push(JSON.parse(line));
        if (responses.length === 4) {
          clearTimeout(timer);
          resolve();
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.on("error", reject);
  });

  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "context.analyze", arguments: { snapshot_json: "{" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "context.analyze", arguments: { snapshot_json: snapshot } } }
  ];
  child.stdin.write(`${messages.map(JSON.stringify).join("\n")}\n`);
  await done;

  assert.equal(responses[0].result.serverInfo.name, "context-surface-analyzer");
  assert.equal(responses[0].result.protocolVersion, "2025-11-25");
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ["context.analyze", "context.diff"]);
  assert.ok(responses[1].result.tools.every((tool) => tool.inputSchema.additionalProperties === false));
  assert.ok(responses[1].result.tools.every((tool) => tool.outputSchema?.type === "object"));
  assert.ok(responses[1].result.tools.every((tool) => tool.outputSchema?.oneOf?.length === 2));
  assert.ok(responses[1].result.tools.every((tool) => tool.outputSchema.oneOf.every((branch) => branch.additionalProperties === false)));
  assert.ok(responses[1].result.tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.openWorldHint));
  assert.equal(responses[2].result.structuredContent.error.code, "INVALID_JSON");
  assert.equal(responses[3].result.structuredContent.status, "ok");
});

test("unknown tool names outside the advertised schema stay out of error details", () => {
  for (const hostile of [123, null, { nested: true }, "x".repeat(257)]) {
    const response = callTool(hostile, {});
    assert.equal(response.structuredContent.error.code, "UNKNOWN_TOOL");
    assert.equal(response.structuredContent.error.details, undefined);
  }
  const named = callTool("other.tool", {});
  assert.equal(named.structuredContent.error.code, "UNKNOWN_TOOL");
  assert.deepEqual(named.structuredContent.error.details, { name: "other.tool" });
});
