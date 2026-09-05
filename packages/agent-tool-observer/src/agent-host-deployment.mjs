import fs from "node:fs";
import { hashIdentifier } from "./core/hash.mjs";
import { putAgentHostDeploymentObservation } from "./db.mjs";
import { ObserverError } from "./errors.mjs";

const FORMAT = "openadam.agent-host-deployment-observation.v0.1";
const MAX_FILE_BYTES = 512 * 1024;
const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/u;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ObserverError("AGENT_HOST_DEPLOYMENT_INVALID", `${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ObserverError("AGENT_HOST_DEPLOYMENT_INVALID", `${label} contains unknown fields`);
  }
}

function boundedString(value, maximum, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new ObserverError("AGENT_HOST_DEPLOYMENT_INVALID", `${label} is invalid`);
  }
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ObserverError("AGENT_HOST_DEPLOYMENT_INVALID", `${label} is invalid`);
  }
  return value;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ObserverError("AGENT_HOST_DEPLOYMENT_INVALID", `${label} is invalid`);
  }
  return value;
}

function digest(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ObserverError("AGENT_HOST_DEPLOYMENT_INVALID", `${label} is invalid`);
  }
  return value.replace(/^sha256:/u, "");
}

function semanticKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function normalizeComponents(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new ObserverError("AGENT_HOST_DEPLOYMENT_INVALID", "components is invalid");
  }
  const ids = new Set();
  const bindings = new Set();
  return value.map((item, index) => {
    object(item, `components[${index}]`);
    exactKeys(item, new Set(["id", "version", "artifactSha256", "toolNames"]), `components[${index}]`);
    const id = boundedString(item.id, 160, `components[${index}].id`);
    if (ids.has(id)) throw new ObserverError("AGENT_HOST_DEPLOYMENT_INVALID", "component ids must be unique");
    ids.add(id);
    if (!Array.isArray(item.toolNames) || item.toolNames.length > 64) {
      throw new ObserverError("AGENT_HOST_DEPLOYMENT_INVALID", `components[${index}].toolNames is invalid`);
    }
    const toolNames = item.toolNames.map((toolName, toolIndex) => {
      const normalized = boundedString(toolName, 200, `components[${index}].toolNames[${toolIndex}]`);
      const key = semanticKey(normalized);
      if (!key || bindings.has(key)) {
        throw new ObserverError("AGENT_HOST_DEPLOYMENT_INVALID", "tool bindings must be non-empty and unique");
      }
      bindings.add(key);
      return normalized;
    });
    return {
      id,
      version: boundedString(item.version, 100, `components[${index}].version`),
      artifactSha256: digest(item.artifactSha256, `components[${index}].artifactSha256`, { nullable: true }),
      toolNames
    };
  });
}

export function normalizeAgentHostDeployment(value) {
  object(value, "deployment");
  exactKeys(value, new Set([
    "schemaVersion", "observedAtMs", "activatedAtMs", "channel", "releaseId",
    "suiteVersion", "profile", "components", "context"
  ]), "deployment");
  if (value.schemaVersion !== FORMAT) {
    throw new ObserverError("AGENT_HOST_DEPLOYMENT_UNSUPPORTED", "Agent Host deployment format is unsupported");
  }
  if (!new Set(["release", "development"]).has(value.channel)) {
    throw new ObserverError("AGENT_HOST_DEPLOYMENT_INVALID", "channel is invalid");
  }
  const context = value.context === null || value.context === undefined ? null : object(value.context, "context");
  if (context) exactKeys(context, new Set(["sourceId", "sourceRevision", "catalogSha256", "catalogBytes", "toolCount"]), "context");
  const normalized = {
    observedAtMs: timestamp(value.observedAtMs, "observedAtMs"),
    activatedAtMs: timestamp(value.activatedAtMs, "activatedAtMs"),
    channel: value.channel,
    releaseId: boundedString(value.releaseId, 200, "releaseId", { nullable: true }),
    suiteVersion: boundedString(value.suiteVersion, 100, "suiteVersion"),
    profile: boundedString(value.profile, 100, "profile"),
    components: normalizeComponents(value.components),
    context: context ? {
      sourceId: boundedString(context.sourceId, 200, "context.sourceId"),
      sourceRevision: boundedString(context.sourceRevision, 200, "context.sourceRevision"),
      catalogSha256: digest(context.catalogSha256, "context.catalogSha256"),
      catalogBytes: count(context.catalogBytes, "context.catalogBytes"),
      toolCount: count(context.toolCount, "context.toolCount")
    } : null,
    sourceFormat: FORMAT
  };
  if (normalized.channel === "release" && normalized.releaseId === null) {
    throw new ObserverError("AGENT_HOST_DEPLOYMENT_INVALID", "release channel requires releaseId");
  }
  const identity = JSON.stringify({
    ...normalized,
    observedAtMs: undefined
  });
  return { ...normalized, deploymentId: hashIdentifier("agent-host-deployment", identity) };
}

export function ingestAgentHostDeployment(database, filePath) {
  let info;
  try {
    info = fs.lstatSync(filePath);
  } catch (error) {
    throw new ObserverError("AGENT_HOST_DEPLOYMENT_FILE_UNAVAILABLE", "Agent Host deployment file is unavailable", { cause: error });
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) {
    throw new ObserverError("AGENT_HOST_DEPLOYMENT_FILE_INVALID", "Agent Host deployment must be a bounded regular non-symlinked file");
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new ObserverError("AGENT_HOST_DEPLOYMENT_INVALID", "Agent Host deployment is not valid JSON", { cause: error });
  }
  const deployment = normalizeAgentHostDeployment(value);
  return {
    status: "completed",
    deploymentsWritten: putAgentHostDeploymentObservation(database, deployment),
    deployment: {
      releaseId: deployment.releaseId,
      suiteVersion: deployment.suiteVersion,
      profile: deployment.profile,
      activatedAtMs: deployment.activatedAtMs,
      componentCount: deployment.components.length,
      boundToolCount: deployment.components.reduce((sum, component) => sum + component.toolNames.length, 0)
    },
    rawContentStored: false,
    sourcePathsStored: false
  };
}

export { FORMAT as AGENT_HOST_DEPLOYMENT_FORMAT };
