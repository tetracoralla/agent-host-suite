const OPENADAM_NAMESPACES = new Set([
  "data_transformer",
  "decision_table",
  "equatorium",
  "icon_svg_select",
  "laniakea",
  "math_anchor",
  "migratory_time",
  "sei",
  "state_machine"
]);

const ORCHESTRATION_TOOLS = new Set([
  "exec",
  "js",
  "wait",
  "wait_agent",
  "spawn_agent",
  "send_message",
  "followup_task",
  "interrupt_agent",
  "list_agents",
  "ToolSearch",
  "Skill",
  "Agent",
  "SendMessage",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TaskOutput",
  "TaskStop",
  "TodoWrite",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "ScheduleWakeup"
]);

const NATIVE_SHELL_TOOLS = new Set([
  "Bash",
  "Shell",
  "exec_command",
  "write_stdin",
  "local_shell",
  "local_shell_call"
]);

const HOST_BUILTINS = new Set([
  "Read",
  "Edit",
  "Write",
  "NotebookEdit",
  "LSP",
  "apply_patch",
  "view_image",
  "update_plan",
  "WebFetch",
  "WebSearch",
  "web_search",
  "web__run",
  "image_gen__imagegen"
]);

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:+-]{1,256}$/;
const STATIC_TOOL_PREFIXES = ["mcp__", "codex_app__", "web__", "image_gen__"];
const STATIC_DIRECT_TOOLS = new Set([
  ...ORCHESTRATION_TOOLS,
  ...NATIVE_SHELL_TOOLS,
  ...HOST_BUILTINS,
  "exec_command",
  "apply_patch",
  "write_stdin",
  "view_image",
  "update_plan"
]);

export function normalizeToolName(value) {
  if (typeof value !== "string" || !TOOL_NAME_PATTERN.test(value)) {
    return "<invalid-tool-name>";
  }
  return value;
}

export function toolNamespace(toolName) {
  const normalized = normalizeToolName(toolName);
  const mcpMatch = /^mcp__([A-Za-z0-9_-]+)__/.exec(normalized);
  if (mcpMatch) return mcpMatch[1].replaceAll("-", "_");
  const dottedMatch = /^([A-Za-z0-9_-]+)[.:]/.exec(normalized);
  return dottedMatch ? dottedMatch[1].replaceAll("-", "_") : null;
}

export function classifyTool(toolName) {
  const normalized = normalizeToolName(toolName);
  const namespace = toolNamespace(normalized);
  if (normalized.startsWith("mcp__")) {
    return {
      toolName: normalized,
      namespace,
      routeClass: "mcp",
      isOpenAdam: namespace !== null && OPENADAM_NAMESPACES.has(namespace)
    };
  }
  if (NATIVE_SHELL_TOOLS.has(normalized)) {
    return { toolName: normalized, namespace: null, routeClass: "native-shell", isOpenAdam: false };
  }
  if (ORCHESTRATION_TOOLS.has(normalized)) {
    return { toolName: normalized, namespace: null, routeClass: "orchestration", isOpenAdam: false };
  }
  if (HOST_BUILTINS.has(normalized) || normalized.startsWith("codex_app__")) {
    return { toolName: normalized, namespace, routeClass: "host-builtin", isOpenAdam: false };
  }
  return { toolName: normalized, namespace, routeClass: "unknown", isOpenAdam: false };
}

function isStaticToolName(name) {
  return STATIC_DIRECT_TOOLS.has(name) || STATIC_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function codePositionMap(source) {
  const code = new Uint8Array(source.length);
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (character === "'" || character === '"' || character === "`") {
        state = character;
      } else if (character === "/" && next === "/") {
        state = "line-comment";
        index += 1;
      } else if (character === "/" && next === "*") {
        state = "block-comment";
        index += 1;
      } else {
        code[index] = 1;
      }
      continue;
    }
    if (state === "line-comment") {
      if (character === "\n" || character === "\r") {
        state = "code";
        code[index] = 1;
      }
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (character === "\\") {
      index += 1;
    } else if (character === state) {
      state = "code";
    }
  }
  return code;
}

export function extractNestedToolNames(source, maximumBytes = 2 * 1024 * 1024) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > maximumBytes) return [];
  const names = [];
  const codePositions = codePositionMap(source);
  const expression = /\btools\s*(?:\.\s*([A-Za-z_$][A-Za-z0-9_$]*)|\[\s*["']([^"']+)["']\s*\])\s*\(/g;
  for (const match of source.matchAll(expression)) {
    if (codePositions[match.index] !== 1) continue;
    const candidate = match[1] ?? match[2];
    if (TOOL_NAME_PATTERN.test(candidate) && isStaticToolName(candidate)) names.push(candidate);
  }
  return names;
}

export function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function finiteNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
