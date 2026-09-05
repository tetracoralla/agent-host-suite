import fs from "node:fs";
import { ObserverError } from "../errors.mjs";

const WHITESPACE = new Set([0x09, 0x0a, 0x0d, 0x20]);

export function readJsonObjectsIncremental(options) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(options.filePath, flags);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new ObserverError("JSON_OBJECT_SOURCE_INVALID", "JSON object source must be a regular file");
    const identity = `${stat.dev}:${stat.ino}`;
    if (options.expectedIdentity !== null && options.expectedIdentity !== undefined && options.expectedIdentity !== identity) {
      throw new ObserverError("JSON_OBJECT_SOURCE_REPLACED", "JSON object source changed during collection");
    }
    const startOffset = Math.max(0, Math.min(Number(options.startOffset ?? 0), stat.size));
    const readableBytes = Math.max(0, Math.min(Number(options.maximumBytes), stat.size - startOffset));
    const buffer = Buffer.allocUnsafe(readableBytes);
    let bytesRead = 0;
    while (bytesRead < readableBytes) {
      const count = fs.readSync(descriptor, buffer, bytesRead, readableBytes - bytesRead, startOffset + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }

    let cursor = 0;
    let committedOffset = startOffset;
    let recordsRead = 0;
    let skippedRecords = 0;
    while (cursor < bytesRead && recordsRead < options.maximumRecords) {
      if (Date.now() >= options.deadlineMs) break;
      while (cursor < bytesRead && WHITESPACE.has(buffer[cursor])) cursor += 1;
      if (cursor >= bytesRead) {
        committedOffset = startOffset + cursor;
        break;
      }
      if (buffer[cursor] !== 0x7b) {
        throw new ObserverError("JSON_OBJECT_RECORD_INVALID", "JSON object stream contains a non-object record");
      }
      const recordStart = cursor;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let complete = false;
      for (; cursor < bytesRead; cursor += 1) {
        const byte = buffer[cursor];
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === 0x5c) escaped = true;
          else if (byte === 0x22) inString = false;
        } else if (byte === 0x22) {
          inString = true;
        } else if (byte === 0x7b || byte === 0x5b) {
          depth += 1;
          if (depth > options.maximumDepth) throw new ObserverError("JSON_OBJECT_DEPTH_EXCEEDED", "JSON object exceeded the configured depth bound");
        } else if (byte === 0x7d || byte === 0x5d) {
          depth -= 1;
          if (depth < 0) throw new ObserverError("JSON_OBJECT_RECORD_INVALID", "JSON object stream contains unbalanced JSON");
          if (depth === 0) {
            cursor += 1;
            complete = true;
            break;
          }
        }
        if (cursor - recordStart + 1 > options.maximumObjectBytes) {
          throw new ObserverError("JSON_OBJECT_RECORD_TOO_LARGE", "JSON object exceeded the configured byte bound");
        }
      }
      if (!complete) {
        cursor = recordStart;
        break;
      }
      const recordBytes = cursor - recordStart;
      let record;
      try {
        record = JSON.parse(buffer.subarray(recordStart, cursor).toString("utf8"));
      } catch {
        skippedRecords += 1;
        throw new ObserverError("JSON_OBJECT_RECORD_INVALID", "JSON object stream contains malformed JSON");
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new ObserverError("JSON_OBJECT_RECORD_INVALID", "JSON object stream record must be an object");
      }
      options.onRecord(record, { recordBytes });
      recordsRead += 1;
      committedOffset = startOffset + cursor;
    }
    while (cursor < bytesRead && WHITESPACE.has(buffer[cursor])) cursor += 1;
    if (cursor === bytesRead) committedOffset = startOffset + cursor;
    return {
      fileIdentity: identity,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      nextOffset: committedOffset,
      bytesRead,
      recordsRead,
      skippedRecords,
      hasBacklog: committedOffset < stat.size
    };
  } finally {
    fs.closeSync(descriptor);
  }
}
