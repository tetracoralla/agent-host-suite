import fs from "node:fs";
import path from "node:path";
import { ObserverError } from "../errors.mjs";
import { exceedsJsonDepth } from "./json-depth.mjs";

const READ_BUFFER_BYTES = 64 * 1024;

function assertRealDirectory(root) {
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ObserverError("SOURCE_ROOT_INVALID", "Provider source root must be a real directory");
  }
  return fs.realpathSync(root);
}

export function discoverJsonlFiles(roots, options = {}) {
  const maximumFiles = options.maximumFiles ?? 2_000;
  const maximumDepth = options.maximumDepth ?? 12;
  const minimumMtimeMs = options.minimumMtimeMs ?? 0;
  const files = [];
  let presentRoots = 0;
  let skippedSymlinks = 0;
  let truncated = false;

  for (const configuredRoot of roots) {
    const realRoot = assertRealDirectory(configuredRoot);
    if (realRoot === null) continue;
    presentRoots += 1;
    const pending = [{ directory: realRoot, depth: 0 }];
    while (pending.length > 0 && files.length < maximumFiles) {
      const current = pending.pop();
      let entries;
      try {
        entries = fs.readdirSync(current.directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (files.length >= maximumFiles) {
          truncated = true;
          break;
        }
        const candidate = path.join(current.directory, entry.name);
        let stat;
        try {
          stat = fs.lstatSync(candidate);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) {
          skippedSymlinks += 1;
          continue;
        }
        if (stat.isDirectory()) {
          if (current.depth < maximumDepth) pending.push({ directory: candidate, depth: current.depth + 1 });
          continue;
        }
        if (!stat.isFile() || path.extname(entry.name) !== ".jsonl" || stat.mtimeMs < minimumMtimeMs) continue;
        if (typeof options.acceptFileName === "function" && !options.acceptFileName(entry.name)) continue;
        const resolved = fs.realpathSync(candidate);
        if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) {
          skippedSymlinks += 1;
          continue;
        }
        files.push({
          filePath: candidate,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          fileIdentity: `${stat.dev}:${stat.ino}`
        });
      }
    }
    if (pending.length > 0) truncated = true;
  }

  files.sort((left, right) => right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath));
  return { files, presentRoots, skippedSymlinks, truncated };
}

function parseLine(buffer, maximumDepth) {
  let end = buffer.length;
  if (end > 0 && buffer[end - 1] === 0x0d) end -= 1;
  if (end === 0) return { empty: true };
  try {
    const value = JSON.parse(buffer.toString("utf8", 0, end));
    if (exceedsJsonDepth(value, maximumDepth)) return { skipped: "depth" };
    return { value };
  } catch {
    return { skipped: "malformed" };
  }
}

export function readJsonlIncremental(options) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(options.filePath, flags);
  try {
    const initialStat = fs.fstatSync(descriptor);
    if (!initialStat.isFile()) throw new ObserverError("SOURCE_FILE_INVALID", "Provider source must be a regular file");
    const fileIdentity = `${initialStat.dev}:${initialStat.ino}`;
    let startOffset = options.startOffset ?? 0;
    let discardingLine = options.discardingLine === true;
    if (options.expectedIdentity !== fileIdentity || startOffset > initialStat.size) {
      startOffset = 0;
      discardingLine = false;
    }
    const maximumBytes = Math.max(0, options.maximumBytes);
    const maximumLineBytes = options.maximumLineBytes;
    const maximumLines = options.maximumLines;
    const maximumDepth = options.maximumDepth;
    const deadlineMs = options.deadlineMs;
    const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, Math.max(1, maximumBytes)));
    const parts = [];
    let partBytes = 0;
    let readOffset = startOffset;
    let committedOffset = startOffset;
    let bytesRead = 0;
    let linesRead = 0;
    let recordsRead = 0;
    let skippedLines = 0;
    let malformedLines = 0;
    let depthLines = 0;
    let stoppedForLimit = false;

    while (bytesRead < maximumBytes && linesRead < maximumLines && Date.now() < deadlineMs) {
      const requested = Math.min(buffer.length, maximumBytes - bytesRead);
      const count = fs.readSync(descriptor, buffer, 0, requested, readOffset);
      if (count === 0) break;
      let segmentStart = 0;
      while (segmentStart < count) {
        const foundNewline = buffer.indexOf(0x0a, segmentStart);
        const newline = foundNewline >= 0 && foundNewline < count ? foundNewline : -1;
        const segmentEnd = newline === -1 ? count : newline;
        const segmentLength = segmentEnd - segmentStart;
        if (!discardingLine) {
          if (partBytes + segmentLength > maximumLineBytes) {
            parts.length = 0;
            partBytes = 0;
            discardingLine = true;
          } else if (segmentLength > 0) {
            parts.push(Buffer.from(buffer.subarray(segmentStart, segmentEnd)));
            partBytes += segmentLength;
          }
        }
        const absoluteSegmentEnd = readOffset + segmentEnd;
        if (newline === -1) {
          if (discardingLine) committedOffset = absoluteSegmentEnd;
          break;
        }

        linesRead += 1;
        if (discardingLine) {
          skippedLines += 1;
        } else {
          const line = parts.length === 1 ? parts[0] : Buffer.concat(parts, partBytes);
          const parsed = parseLine(line, maximumDepth);
          if (parsed.value !== undefined) {
            options.onRecord(parsed.value);
            recordsRead += 1;
          } else if (parsed.skipped) {
            skippedLines += 1;
            if (parsed.skipped === "malformed") malformedLines += 1;
            if (parsed.skipped === "depth") depthLines += 1;
          }
        }
        parts.length = 0;
        partBytes = 0;
        discardingLine = false;
        committedOffset = absoluteSegmentEnd + 1;
        segmentStart = newline + 1;
        if (linesRead >= maximumLines || Date.now() >= deadlineMs) {
          stoppedForLimit = true;
          break;
        }
      }
      readOffset += count;
      bytesRead += count;
      if (stoppedForLimit) break;
    }
    const finalStat = fs.fstatSync(descriptor);
    const hasBacklog = committedOffset < finalStat.size;
    return {
      fileIdentity,
      nextOffset: committedOffset,
      sizeBytes: finalStat.size,
      mtimeMs: finalStat.mtimeMs,
      discardingLine,
      bytesRead,
      linesRead,
      recordsRead,
      skippedLines,
      malformedLines,
      depthLines,
      hasBacklog
    };
  } finally {
    fs.closeSync(descriptor);
  }
}
