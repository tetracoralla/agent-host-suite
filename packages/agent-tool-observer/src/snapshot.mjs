import fs from "node:fs";
import path from "node:path";
import { ObserverError } from "./errors.mjs";

const SNAPSHOT_NAMES = new Set(["latest-report.json", "latest-status.json"]);
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

function snapshotPath(config, name) {
  if (!SNAPSHOT_NAMES.has(name)) throw new ObserverError("SNAPSHOT_NAME_INVALID", "Unknown observer snapshot name");
  return path.join(config.stateDir, name);
}

function validateExistingTarget(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ObserverError("SNAPSHOT_TARGET_INVALID", "Observer snapshot target must be a regular non-symlinked file");
  }
}

export function writeSnapshot(config, name, value) {
  const target = snapshotPath(config, name);
  validateExistingTarget(target);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new ObserverError("SNAPSHOT_TOO_LARGE", "Observer snapshot exceeded its complete serialized byte limit");
  }
  const temporary = `${target}.tmp-${process.pid}`;
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, target);
  return target;
}

export function readSnapshot(config, name) {
  const target = snapshotPath(config, name);
  validateExistingTarget(target);
  const stat = fs.lstatSync(target);
  if (stat.size > MAX_SNAPSHOT_BYTES || (stat.mode & 0o077) !== 0) {
    throw new ObserverError("SNAPSHOT_INVALID", "Observer snapshot is oversized or not owner-only");
  }
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    throw new ObserverError("SNAPSHOT_INVALID", "Observer snapshot is not valid JSON");
  }
}
