import { createHash } from "node:crypto";

export function hashIdentifier(kind, value) {
  if (value === undefined || value === null || value === "") return null;
  return createHash("sha256")
    .update("agent-tool-observer\0")
    .update(String(kind))
    .update("\0")
    .update(String(value))
    .digest("hex");
}

export function eventIdentifier(provider, kind, ...parts) {
  return hashIdentifier(`event:${provider}:${kind}`, parts.map((part) => String(part ?? "")).join("\0"));
}
