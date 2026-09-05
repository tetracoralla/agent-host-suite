import assert from "node:assert/strict";
import test from "node:test";
import { classifyTool, extractNestedToolNames, normalizeToolName } from "../src/core/classify.mjs";

test("extractNestedToolNames keeps callable tool methods and rejects array-method lookalikes", () => {
  const source = `
    const rows = tools.map((item) => item);
    const first = tools.find(Boolean);
    const result = await tools.mcp__math_anchor__math_run({ expression: "2+2" });
    await tools["mcp__data_transformer__data_inspect"]({});
    await tools.exec_command({ cmd: "date" });
  `;
  assert.deepEqual(extractNestedToolNames(source), [
    "mcp__math_anchor__math_run",
    "mcp__data_transformer__data_inspect",
    "exec_command"
  ]);
});

test("extractNestedToolNames rejects oversized orchestration source", () => {
  assert.deepEqual(extractNestedToolNames(`tools.mcp__x__y(${"x".repeat(200)})`, 32), []);
});

test("extractNestedToolNames ignores tool-shaped text in strings, templates, and comments", () => {
  const source = [
    'const quoted = "tools.mcp__x__y({})";',
    "const bracketed = 'tools[\\\"mcp__x__y\\\"]({})';",
    "const template = `tools.mcp__x__y({})`;",
    "// tools.mcp__x__y({});",
    "/* tools.mcp__x__y({}); */",
    "await tools.mcp__math_anchor__math_run({});"
  ].join("\n");
  assert.deepEqual(extractNestedToolNames(source), ["mcp__math_anchor__math_run"]);
});

test("classifyTool separates OpenAdam MCP, shell, and host routes", () => {
  assert.deepEqual(classifyTool("mcp__math_anchor__math_run"), {
    toolName: "mcp__math_anchor__math_run",
    namespace: "math_anchor",
    routeClass: "mcp",
    isOpenAdam: true
  });
  assert.equal(classifyTool("Bash").routeClass, "native-shell");
  assert.equal(classifyTool("Read").routeClass, "host-builtin");
  assert.equal(normalizeToolName("a".repeat(300)), "<invalid-tool-name>");
});

test("classifyTool recognizes hyphenated OpenAdam MCP servers and current orchestration tools", () => {
  assert.deepEqual(classifyTool("mcp__data-transformer__data_transform"), {
    toolName: "mcp__data-transformer__data_transform",
    namespace: "data_transformer",
    routeClass: "mcp",
    isOpenAdam: true
  });
  assert.equal(classifyTool("Skill").routeClass, "orchestration");
  assert.equal(classifyTool("TodoWrite").routeClass, "orchestration");
  assert.equal(classifyTool("NotebookEdit").routeClass, "host-builtin");
});
