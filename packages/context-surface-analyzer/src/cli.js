#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { LIMITS } from "./constants.js";
import { executeAnalyze, executeDiff } from "./core.js";
import { boundedErrorResult, ContextSurfaceError } from "./errors.js";

const HELP = `Usage:
  context-surface analyze <snapshot.json> [--max-output-bytes <n>]
  context-surface diff <before.json> <after.json> [--max-output-bytes <n>]

The CLI reads explicit local files, writes one JSON value to stdout, and never
modifies the input snapshots.`;

function parseArguments(argv) {
  const args = [...argv];
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { command: "help" };
  const command = args.shift();
  let maxOutputBytes;
  const optionIndex = args.indexOf("--max-output-bytes");
  if (optionIndex !== -1) {
    const raw = args[optionIndex + 1];
    if (raw === undefined || !/^\d+$/.test(raw)) {
      throw new ContextSurfaceError("INVALID_ARGUMENT", "--max-output-bytes requires a positive integer.");
    }
    maxOutputBytes = Number(raw);
    args.splice(optionIndex, 2);
  }
  if (args.some((arg) => arg.startsWith("--"))) {
    throw new ContextSurfaceError("INVALID_ARGUMENT", "An unsupported CLI option was supplied.");
  }
  if (command === "analyze" && args.length === 1) return { command, files: args, maxOutputBytes };
  if (command === "diff" && args.length === 2) return { command, files: args, maxOutputBytes };
  throw new ContextSurfaceError("INVALID_ARGUMENT", "Command arguments do not match the supported usage.");
}

function requestedErrorLimit(argv) {
  const index = argv.indexOf("--max-output-bytes");
  const value = index === -1 ? undefined : Number(argv[index + 1]);
  return Number.isSafeInteger(value) && value >= LIMITS.minResultBytes && value <= LIMITS.hardMaxResultBytes
    ? value
    : LIMITS.defaultResultBytes;
}

async function readSnapshotFile(path) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new ContextSurfaceError("FILE_READ_ERROR", "A snapshot file could not be read.", { path });
  }
  if (!metadata.isFile()) throw new ContextSurfaceError("FILE_READ_ERROR", "Snapshot path must name a regular file.", { path });
  if (metadata.size > LIMITS.maxSnapshotBytes) {
    throw new ContextSurfaceError("LIMIT_EXCEEDED", "Snapshot file exceeds the input byte limit.", {
      path,
      actual: metadata.size,
      limit: LIMITS.maxSnapshotBytes
    });
  }
  return readFile(path, "utf8");
}

export async function runCli(argv) {
  const parsed = parseArguments(argv);
  if (parsed.command === "help") return { exitCode: 0, output: HELP };
  if (parsed.command === "analyze") {
    const snapshotJson = await readSnapshotFile(parsed.files[0]);
    return { exitCode: 0, output: executeAnalyze(snapshotJson, parsed.maxOutputBytes).json };
  }
  const [beforeJson, afterJson] = await Promise.all(parsed.files.map(readSnapshotFile));
  return { exitCode: 0, output: executeDiff(beforeJson, afterJson, parsed.maxOutputBytes).json };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const outcome = await runCli(process.argv.slice(2));
    process.stdout.write(`${outcome.output}\n`);
    process.exitCode = outcome.exitCode;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(boundedErrorResult(error, requestedErrorLimit(process.argv.slice(2))))}\n`);
    process.exitCode = 1;
  }
}
