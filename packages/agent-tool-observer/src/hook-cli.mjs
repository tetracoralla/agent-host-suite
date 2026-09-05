#!/usr/bin/env node
import { processHookInput, HOOK_INPUT_MAX_BYTES } from "./hook-bridge.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArguments(argumentsList) {
  const options = { adapterId: null, eventName: null, output: null, providerVersion: null };
  const fields = new Map([
    ["--adapter", "adapterId"],
    ["--event", "eventName"],
    ["--output", "output"],
    ["--provider-version", "providerVersion"]
  ]);
  const seen = new Set();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const option = argumentsList[index];
    if (!fields.has(option) || seen.has(option)) throw new Error("invalid hook bridge arguments");
    seen.add(option);
    const value = argumentsList[++index];
    if (!value) throw new Error("missing hook bridge argument value");
    options[fields.get(option)] = value;
  }
  if (!options.adapterId || !options.eventName || !options.output) throw new Error("incomplete hook bridge arguments");
  return options;
}

async function readStdinBounded(input = process.stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > HOOK_INPUT_MAX_BYTES) throw new Error("hook input too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

export async function main(argumentsList = process.argv.slice(2), input = process.stdin) {
  try {
    const options = parseArguments(argumentsList);
    processHookInput({ ...options, input: await readStdinBounded(input) });
  } catch {
    // Official hook surfaces may let a hook alter or block Agent behavior.
    // Observation is strictly passive, so every local bridge failure is ignored.
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; });
}

export { parseArguments, readStdinBounded };
