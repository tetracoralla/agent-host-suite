import { nonNegativeInteger } from "../core/classify.mjs";
import { eventIdentifier, hashIdentifier } from "../core/hash.mjs";
import { applySessionStartObservation, completeToolEvent, putToolEvent, putUsageEvent } from "../db.mjs";
import { jsonPayloadBytes, normalizedToolFields, scanJsonlProvider } from "./jsonl-provider.mjs";

function timestampMs(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function createClaudeParser({ database, sourceId, recordedAtMs }) {
  let writes = 0;
  const sessionStarts = new Map();
  return {
    onRecord(record) {
      if (!record || typeof record !== "object") return;
      const sessionId = record.sessionId ?? sourceId;
      const occurredAtMs = timestampMs(record.timestamp);
      const sessionHash = hashIdentifier("claude-session", sessionId);
      const previousSessionStart = sessionStarts.get(sessionId) ?? null;
      const sessionStartedAtMs = occurredAtMs === null
        ? previousSessionStart
        : previousSessionStart === null
          ? occurredAtMs
          : Math.min(previousSessionStart, occurredAtMs);
      if (sessionStartedAtMs !== null && sessionStartedAtMs !== previousSessionStart) {
        sessionStarts.set(sessionId, sessionStartedAtMs);
        applySessionStartObservation(database, "claude", sessionHash, sessionStartedAtMs);
      }
      const content = Array.isArray(record.message?.content) ? record.message.content : [];
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "tool_use" && item.id) {
          const normalized = normalizedToolFields(item.name);
          writes += putToolEvent(database, {
            eventId: eventIdentifier("claude", "tool", sessionId, item.id),
            provider: "claude",
            sourceId,
            sessionHash,
            turnHash: hashIdentifier("claude-turn", record.parentUuid ?? record.uuid),
            callHash: hashIdentifier("claude-call", item.id),
            sessionStartedAtMs,
            occurredAtMs,
            completedAtMs: null,
            ...normalized,
            derived: false,
            status: "observed",
            durationMs: null,
            retryCount: null,
            requestBytes: jsonPayloadBytes(item.input),
            responseBytes: null,
            sourceFormat: "claude-project-jsonl",
            recordedAtMs
          });
        }
        if (item.type === "tool_result" && item.tool_use_id) {
          const status = item.is_error === true ? "error" : "completed";
          writes += completeToolEvent(
            database,
            eventIdentifier("claude", "tool", sessionId, item.tool_use_id),
            status,
            occurredAtMs ?? recordedAtMs,
            jsonPayloadBytes(item.content)
          );
        }
      }
      const usage = record.message?.usage;
      if (record.type !== "assistant" || !usage || typeof usage !== "object") return;
      const messageId = record.message?.id ?? record.uuid;
      if (!messageId) return;
      const inputTokens = nonNegativeInteger(usage.input_tokens);
      const cachedInputTokens = nonNegativeInteger(usage.cache_read_input_tokens);
      const outputTokens = nonNegativeInteger(usage.output_tokens);
      const reasoningTokens = nonNegativeInteger(usage.output_tokens_details?.reasoning_tokens);
      const totalTokens = [inputTokens, outputTokens].every((value) => value !== null)
        ? inputTokens + outputTokens
        : null;
      writes += putUsageEvent(database, {
        eventId: eventIdentifier("claude", "message-usage", sessionId, messageId),
        provider: "claude",
        sessionHash,
        turnHash: hashIdentifier("claude-turn", record.parentUuid ?? record.uuid),
        occurredAtMs,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningTokens,
        totalTokens,
        durationMs: null,
        sourceFormat: "claude-project-jsonl",
        recordedAtMs
      });
    },
    eventsWritten() {
      return writes;
    }
  };
}

export function scanClaude(options) {
  return scanJsonlProvider({
    ...options,
    provider: "claude",
    roots: options.config.claudeRoots,
    limits: options.config.limits,
    minimumMtimeMs: options.minimumMtimeMs,
    primeFromStart: true,
    createParser: createClaudeParser
  });
}

export { createClaudeParser };
