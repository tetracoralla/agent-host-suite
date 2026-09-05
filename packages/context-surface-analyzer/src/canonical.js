import { createHash } from "node:crypto";
import { TextEncoder } from "node:util";

const encoder = new TextEncoder();

export function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

export function utf8Bytes(value) {
  const text = typeof value === "string" ? value : canonicalize(value);
  return encoder.encode(text).byteLength;
}

export function sha256(value) {
  const text = typeof value === "string" ? value : canonicalize(value);
  return createHash("sha256").update(text, "utf8").digest("hex");
}
