import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const SCHEMA_VERSION = "openadam.agent-shell-trace-bridge.v0.1";
const ADAPTER = Object.freeze({
  id: "openadam.deepseek-harness-session-events",
  version: "0.1.0",
  sourceFormat: "deepseek-harness-session-event-v0"
});

function bytes(value) {
  if (value === undefined) return null;
  try {
    return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    return null;
  }
}

function token(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stableCode(value, fallback) {
  return typeof value === "string" && /^[A-Z0-9_]{1,100}$/u.test(value) ? value : fallback;
}

function opaqueIdentifier(namespace, value) {
  if (value === null || value === undefined) return null;
  return createHash("sha256").update(namespace).update("\0").update(String(value)).digest("hex");
}

function bridgeBase(session, event, config) {
  const sessionId = opaqueIdentifier("deepseek-harness-session", session.header?.id ?? session.id ?? "unknown");
  return {
    schemaVersion: SCHEMA_VERSION,
    adapter: {
      ...ADAPTER,
      providerVersion: typeof config.providerVersion === "string" ? config.providerVersion : null
    },
    provider: "deepseek-harness",
    eventId: opaqueIdentifier("deepseek-harness-event", `${sessionId}:${event.seq}`),
    sessionId,
    occurredAt: Number.isSafeInteger(event.time) && event.time >= 0 ? event.time : Date.now(),
    contentIncluded: false
  };
}

function toolNames(header) {
  return Array.isArray(header?.tools)
    ? [...new Set(header.tools.map((tool) => tool?.name).filter((name) => typeof name === "string" && Buffer.byteLength(name) <= 256))].slice(0, 2_000)
    : [];
}

function messageBlocks(message) {
  return Array.isArray(message?.content) ? message.content : [];
}

export function createDeepSeekEventProjector(config = {}) {
  const state = new Map();
  const forSession = (session) => {
    const id = String(session.header?.id ?? session.id ?? "unknown");
    if (!state.has(id)) state.set(id, { header: null, stepStarts: new Map(), callNames: new Map() });
    return state.get(id);
  };
  return {
    project(session, event) {
      if (!event || typeof event !== "object" || typeof event.type !== "string") return [];
      const current = forSession(session);
      const base = bridgeBase(session, event, config);
      if (event.type === "request/header") {
        current.header = event.data?.header ?? null;
        return [];
      }
      if (event.type === "step/start") {
        current.stepStarts.set(`${event.data?.turn}:${event.data?.step}`, base.occurredAt);
        return [];
      }
      if (event.type === "assistant/message") {
        const turn = event.data?.turn;
        const step = event.data?.step;
        const requestId = `${base.sessionId}:${turn}:${step}`;
        const offered = toolNames(current.header);
        const blocks = messageBlocks(event.data?.message);
        const emitted = blocks.filter((block) => block?.type === "tool-call" || block?.type === "tool_use");
        const rationalePresent = blocks.some((block) => block?.type === "reasoning" && typeof block.text === "string" && block.text.length > 0);
        const usage = event.data?.usage ?? {};
        const startedAt = current.stepStarts.get(`${turn}:${step}`) ?? base.occurredAt;
        const modelStep = {
          ...base,
          eventId: `${base.eventId}:model-step`,
          kind: "model-step",
          turnId: turn ?? null,
          requestId,
          completedAt: base.occurredAt,
          model: current.header?.config?.model ?? null,
          querySource: "main-turn",
          status: event.data?.interrupted === true ? "cancelled" : "completed",
          durationMs: Math.max(0, base.occurredAt - startedAt),
          requestMessageCount: null,
          requestBytes: null,
          responseBytes: bytes(event.data?.message),
          offeredToolCount: offered.length,
          emittedToolCallCount: emitted.length,
          inputTokens: token(usage.inputTokens),
          cachedInputTokens: token(usage.cacheReadTokens),
          outputTokens: token(usage.outputTokens),
          reasoningTokens: token(usage.reasoningTokens),
          totalTokens: token(usage.totalTokens),
          selfReportedRationalePresent: rationalePresent
        };
        return [
          modelStep,
          ...offered.map((name, index) => ({
            ...base,
            eventId: `${base.eventId}:offer:${index}`,
            kind: "tool-offer",
            turnId: turn ?? null,
            requestId,
            toolName: name
          }))
        ];
      }
      if (event.type === "tool/call") {
        const sourceCallId = String(event.data?.callId ?? "unknown");
        const callId = opaqueIdentifier("deepseek-harness-call", sourceCallId);
        const name = typeof event.data?.name === "string" ? event.data.name.slice(0, 256) : "unknown-tool";
        current.callNames.set(sourceCallId, name);
        return [{
          ...base,
          kind: "tool-call",
          turnId: event.data?.turn ?? null,
          requestId: `${base.sessionId}:${event.data?.turn}:${event.data?.step}`,
          callId,
          toolName: name,
          status: "observed",
          requestBytes: bytes(event.data?.arguments)
        }];
      }
      if (event.type === "tool/result") {
        const sourceCallId = String(event.data?.message?.source?.callId ?? "unknown");
        const callId = opaqueIdentifier("deepseek-harness-call", sourceCallId);
        return [{
          ...base,
          kind: "tool-result",
          turnId: event.data?.turn ?? null,
          requestId: `${base.sessionId}:${event.data?.turn}:${event.data?.step}`,
          callId,
          toolName: current.callNames.get(sourceCallId) ?? "unknown-tool",
          status: event.data?.error ? "error" : "completed",
          responseBytes: bytes(event.data?.message?.content),
          stableErrorCode: event.data?.error ? stableCode(event.data.error.code, "TOOL_RESULT_ERROR") : null
        }];
      }
      if (event.type === "turn/end") {
        const reason = event.data?.reason?.kind;
        const status = reason === "completed" ? "completed"
          : reason === "aborted" ? "cancelled"
            : reason === "error" ? "error" : "unknown";
        return [{
          ...base,
          kind: "turn-end",
          turnId: event.data?.turn ?? null,
          completedAt: base.occurredAt,
          status,
          stableReason: typeof reason === "string" ? reason.slice(0, 100) : null,
          stableErrorCode: status === "error" ? stableCode(event.data?.reason?.error?.code, "TURN_ERROR") : null
        }];
      }
      return [];
    },
    dispose(session) {
      state.delete(String(session.header?.id ?? session.id ?? "unknown"));
    }
  };
}

function prepareOutput(output) {
  if (typeof output !== "string" || !path.isAbsolute(output)) throw new Error("openAdam Observer bridge output must be an absolute path");
  const directory = path.dirname(output);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("openAdam Observer bridge output directory must be a real directory");
  if (fs.existsSync(output)) {
    const stat = fs.lstatSync(output);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("openAdam Observer bridge output must be a regular file");
    if (process.platform !== "win32") fs.chmodSync(output, 0o600);
  } else {
    const descriptor = fs.openSync(output, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(descriptor);
  }
  const lockPath = `${output}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, { flag: "wx", mode: 0o600 });
      return {
        output,
        release() {
          try {
            const current = fs.lstatSync(lockPath);
            if (current.isFile() && !current.isSymbolicLink()) fs.unlinkSync(lockPath);
          } catch {}
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        const stat = fs.lstatSync(lockPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error("unsafe lock");
        owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) throw new Error("invalid lock owner");
      } catch {
        throw new Error("openAdam Observer bridge lock is unreadable; remove it only after confirming no bridge process is running");
      }
      let active = true;
      try {
        process.kill(owner.pid, 0);
      } catch (probeError) {
        if (probeError?.code === "ESRCH") active = false;
      }
      if (active) throw new Error("openAdam Observer bridge output is already owned by another live process");
      fs.unlinkSync(lockPath);
    }
  }
  throw new Error("openAdam Observer bridge output lock could not be acquired");
}

export class OpenAdamObserverBridge {
  static inject = ["sessions"];

  constructor(ctx, config = {}) {
    this.ctx = ctx;
    const prepared = prepareOutput(config.output);
    this.output = prepared.output;
    this.releaseOutput = prepared.release;
    this.batchDelayMs = Number.isSafeInteger(config.batchDelayMs) && config.batchDelayMs >= 10 && config.batchDelayMs <= 5_000 ? config.batchDelayMs : 100;
    this.maxQueuedEvents = Number.isSafeInteger(config.maxQueuedEvents) && config.maxQueuedEvents >= 100 && config.maxQueuedEvents <= 100_000 ? config.maxQueuedEvents : 10_000;
    this.projector = createDeepSeekEventProjector(config);
    this.pending = [];
    this.timer = null;
    this.chain = Promise.resolve();
    this.dropped = 0;
    this.writeFailures = 0;
    ctx.on("session/event", (session, event) => {
      try {
        for (const projected of this.projector.project(session, event)) this.enqueue(projected);
      } catch (error) {
        ctx.logger?.warn?.(`openAdam Observer bridge projection failed: ${String(error)}`);
      }
    });
    ctx.on("session/disposed", (session) => this.projector.dispose(session));
    ctx.effect(() => async () => {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      await this.flush();
      await this.chain;
      this.releaseOutput();
    }, "openAdam Observer bridge drain");
  }

  enqueue(event) {
    if (this.pending.length >= this.maxQueuedEvents) {
      this.dropped += 1;
      if (this.dropped === 1 || this.dropped % 1_000 === 0) this.ctx.logger?.warn?.(`openAdam Observer bridge queue full; ${this.dropped} metadata events dropped`);
      return;
    }
    this.pending.push(`${JSON.stringify(event)}\n`);
    if (this.timer === null) this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.batchDelayMs);
  }

  async flush() {
    if (this.pending.length === 0) return this.chain;
    const batch = this.pending.join("");
    const eventCount = this.pending.length;
    this.pending = [];
    this.chain = this.chain
      .catch(() => undefined)
      .then(() => fs.promises.appendFile(this.output, batch, { encoding: "utf8", mode: 0o600 }))
      .catch((error) => {
        this.writeFailures += 1;
        this.dropped += eventCount;
        this.ctx.logger?.warn?.(`openAdam Observer bridge write failed; ${eventCount} metadata events were not persisted (${error?.code ?? "WRITE_FAILED"})`);
      });
    await this.chain;
  }
}

export default OpenAdamObserverBridge;
