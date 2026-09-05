import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ObserverError } from "./errors.mjs";
import { resolveStableNodePath } from "./installer.mjs";
import { TRACE_ADAPTERS, traceAdapterById } from "./trace-adapters.mjs";

export const ADAPTER_PLAN_SCHEMA_VERSION = "openadam.agent-shell-adapter-plan.v0.1";

function bridgePath(config, name) {
  return path.join(config.stateDir, "bridges", name);
}

function configuredBridgePath(config, name) {
  return config.traceBridgeLogs?.find((item) => path.basename(item) === name) ?? bridgePath(config, name);
}

function hookLauncherPath(config) {
  return path.join(config.stateDir, "runtime", "trace-hook.mjs");
}

function quoteCommandArgument(value, platformName) {
  const text = String(value);
  if (/[\u0000\r\n]/u.test(text)) throw new ObserverError("TRACE_ADAPTER_PLAN_INVALID", "Hook command contains unsupported characters");
  if (platformName === "win32") return `"${text.replaceAll('"', '\\"')}"`;
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function hookArguments(adapterId, event, output) {
  return ["--adapter", adapterId, "--event", event, "--output", output];
}

function claudeHook(nodePath, launcher, adapterId, event, output, platformName) {
  const command = [nodePath, launcher, ...hookArguments(adapterId, event, output)]
    .map((value) => quoteCommandArgument(value, platformName))
    .join(" ");
  return {
    matcher: "*",
    hooks: [{ type: "command", command, async: true }]
  };
}

function copilotHook(nodePath, launcher, adapterId, event, output) {
  return {
    type: "command",
    exec: nodePath,
    args: [launcher, ...hookArguments(adapterId, event, output)],
    timeoutSec: 2
  };
}

function requireInstalledLauncher(config) {
  const launcher = hookLauncherPath(config);
  if (!fs.existsSync(launcher)) {
    throw new ObserverError("TRACE_ADAPTER_PLAN_UNAVAILABLE", "Observer must be installed before generating a hook plan");
  }
  const info = fs.lstatSync(launcher);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ObserverError("TRACE_ADAPTER_PLAN_UNAVAILABLE", "Installed trace hook launcher is unsafe");
  }
  return launcher;
}

export function listAdapterPlans() {
  return {
    schemaVersion: "openadam.agent-shell-adapter-catalog.v0.1",
    status: "ok",
    adapters: TRACE_ADAPTERS.map((adapter) => ({
      id: adapter.id,
      version: adapter.version,
      provider: adapter.provider,
      transport: adapter.transport,
      configuration: ["stable-local-records", "aggregate-store"].includes(adapter.transport)
        ? "automatic-read-only-discovery"
        : "explicit-user-configuration"
    })),
    interpretationStatus: "not-performed"
  };
}

export function buildAdapterPlan(config, adapterId, options = {}) {
  const adapter = traceAdapterById(adapterId);
  if (adapter === null) throw new ObserverError("TRACE_ADAPTER_UNKNOWN", "Unknown trace adapter id");
  const platformName = options.platformName ?? os.platform();
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const environment = options.environment ?? process.env;
  const common = {
    schemaVersion: ADAPTER_PLAN_SCHEMA_VERSION,
    status: "ok",
    adapter: { id: adapter.id, version: adapter.version, provider: adapter.provider, transport: adapter.transport },
    appliesChanges: false,
    passiveStorage: "metadata-only",
    interpretationStatus: "not-performed",
  };

  if (["openadam.codex-session-events", "openadam.claude-project-events", "openadam.zcode-model-io"].includes(adapterId)) {
    return {
      ...common,
      configuration: { kind: "automatic-read-only-discovery", userConfigurationRequired: false },
      removal: { kind: "none", reason: "Observer never changes the Agent shell for this adapter" }
    };
  }

  if (adapterId === "openadam.gemini-cli-otel") {
    const output = config.geminiTelemetryLogs?.[0] ?? bridgePath(config, "gemini-cli-otel.log");
    return {
      ...common,
      configuration: {
        kind: "merge-json",
        userConfigurationRequired: true,
        target: path.join(homeDirectory, ".gemini", "settings.json"),
        fragment: {
          telemetry: { enabled: true, target: "local", outfile: output, logPrompts: false, useCollector: false }
        },
        requiredInvariants: ["telemetry.logPrompts=false", `telemetry.outfile=${output}`]
      },
      removal: { kind: "restore-user-settings", target: path.join(homeDirectory, ".gemini", "settings.json") }
    };
  }

  if (adapterId === "openadam.deepseek-harness-session-events") {
    const modulePath = fileURLToPath(new URL("../integrations/deepseek-harness/index.mjs", import.meta.url));
    return {
      ...common,
      configuration: {
        kind: "application-integration",
        userConfigurationRequired: true,
        module: modulePath,
        output: configuredBridgePath(config, "deepseek-harness.jsonl"),
        publicEvent: "session/event",
        note: "Load the packaged bridge in the owning Harness application and drain it during shutdown"
      },
      removal: { kind: "remove-application-registration", retainedOutput: true }
    };
  }

  const nodePath = resolveStableNodePath(options.nodePath ?? environment.ATO_NODE_EXECUTABLE);
  const launcher = requireInstalledLauncher(config);
  if (adapterId === "openadam.claude-code-hooks") {
    const output = configuredBridgePath(config, "claude-hooks.jsonl");
    const targetRoot = environment.CLAUDE_CONFIG_DIR || path.join(homeDirectory, ".claude");
    const events = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"];
    return {
      ...common,
      configuration: {
        kind: "merge-json",
        userConfigurationRequired: true,
        target: path.join(targetRoot, "settings.json"),
        fragment: { hooks: Object.fromEntries(events.map((event) => [event, [claudeHook(nodePath, launcher, adapterId, event, output, platformName)]])) },
        requiredInvariants: ["command hook", "async=true", "empty stdout and stderr", "exit code 0"]
      },
      removal: { kind: "remove-only-openadam-hook-items", retainedOutput: true }
    };
  }

  if (adapterId === "openadam.github-copilot-cli-hooks") {
    const output = configuredBridgePath(config, "github-copilot-cli.jsonl");
    const copilotRoot = environment.COPILOT_HOME || path.join(homeDirectory, ".copilot");
    const events = ["postToolUse", "postToolUseFailure", "agentStop", "sessionEnd"];
    return {
      ...common,
      configuration: {
        kind: "write-owned-json",
        userConfigurationRequired: true,
        target: path.join(copilotRoot, "hooks", "openadam-agent-host-observer.json"),
        document: {
          version: 1,
          hooks: Object.fromEntries(events.map((event) => [event, [copilotHook(nodePath, launcher, adapterId, event, output)]]))
        },
        requiredInvariants: ["Copilot CLI local hooks", "direct exec without shell", "empty stdout and stderr", "exit code 0"]
      },
      removal: { kind: "remove-owned-file", target: path.join(copilotRoot, "hooks", "openadam-agent-host-observer.json"), retainedOutput: true }
    };
  }

  throw new ObserverError("TRACE_ADAPTER_PLAN_UNAVAILABLE", "This adapter has no configuration plan");
}
