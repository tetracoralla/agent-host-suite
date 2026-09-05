import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { discoverJsonlFiles, readJsonlIncremental } from "../src/core/jsonl-reader.mjs";
import { temporaryRoot } from "./helpers.mjs";

const LIMITS = {
  maximumBytes: 1024 * 1024,
  maximumLineBytes: 128,
  maximumLines: 100,
  maximumDepth: 16,
  deadlineMs: Number.MAX_SAFE_INTEGER
};

test("partial JSONL line is not committed until its newline arrives", () => {
  const root = temporaryRoot();
  try {
    const file = path.join(root, "events.jsonl");
    fs.writeFileSync(file, '{"type":"one"}\n{"type":"two"');
    const firstRecords = [];
    const first = readJsonlIncremental({
      filePath: file,
      startOffset: 0,
      discardingLine: false,
      expectedIdentity: null,
      ...LIMITS,
      onRecord: (record) => firstRecords.push(record)
    });
    assert.deepEqual(firstRecords, [{ type: "one" }]);
    assert.equal(first.nextOffset, Buffer.byteLength('{"type":"one"}\n'));
    assert.equal(first.hasBacklog, true);

    fs.appendFileSync(file, '}\n');
    const secondRecords = [];
    const second = readJsonlIncremental({
      filePath: file,
      startOffset: first.nextOffset,
      discardingLine: first.discardingLine,
      expectedIdentity: first.fileIdentity,
      ...LIMITS,
      onRecord: (record) => secondRecords.push(record)
    });
    assert.deepEqual(secondRecords, [{ type: "two" }]);
    assert.equal(second.nextOffset, fs.statSync(file).size);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("over-limit line can be discarded across runs without retaining content", () => {
  const root = temporaryRoot();
  try {
    const file = path.join(root, "events.jsonl");
    fs.writeFileSync(file, `${"x".repeat(500)}\n{"ok":true}\n`);
    const first = readJsonlIncremental({
      filePath: file,
      startOffset: 0,
      discardingLine: false,
      expectedIdentity: null,
      ...LIMITS,
      maximumBytes: 200,
      onRecord() {}
    });
    assert.equal(first.discardingLine, true);
    assert.equal(first.nextOffset, 200);
    const records = [];
    const second = readJsonlIncremental({
      filePath: file,
      startOffset: first.nextOffset,
      discardingLine: first.discardingLine,
      expectedIdentity: first.fileIdentity,
      ...LIMITS,
      onRecord: (record) => records.push(record)
    });
    assert.equal(second.skippedLines, 1);
    assert.deepEqual(records, [{ ok: true }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discovery skips symlink files and directories", () => {
  const root = temporaryRoot();
  const outside = temporaryRoot();
  try {
    fs.writeFileSync(path.join(root, "real.jsonl"), "{}\n");
    fs.writeFileSync(path.join(outside, "secret.jsonl"), "{}\n");
    fs.symlinkSync(path.join(outside, "secret.jsonl"), path.join(root, "linked.jsonl"));
    fs.symlinkSync(outside, path.join(root, "linked-dir"));
    const discovery = discoverJsonlFiles([root], { maximumFiles: 10, minimumMtimeMs: 0 });
    assert.equal(discovery.files.length, 1);
    assert.equal(discovery.files[0].filePath, fs.realpathSync(path.join(root, "real.jsonl")));
    assert.equal(discovery.skippedSymlinks, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("malformed and over-depth JSON records are skipped with bounded counters", () => {
  const root = temporaryRoot();
  try {
    const file = path.join(root, "events.jsonl");
    fs.writeFileSync(file, '{bad json}\n{"a":{"b":{"c":1}}}\n{"ok":true}\n');
    const records = [];
    const result = readJsonlIncremental({
      filePath: file,
      startOffset: 0,
      discardingLine: false,
      expectedIdentity: null,
      ...LIMITS,
      maximumDepth: 2,
      onRecord: (record) => records.push(record)
    });
    assert.equal(result.malformedLines, 1);
    assert.equal(result.depthLines, 1);
    assert.equal(result.skippedLines, 2);
    assert.deepEqual(records, [{ ok: true }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("truncation and file replacement reset an obsolete cursor", () => {
  const root = temporaryRoot();
  try {
    const file = path.join(root, "events.jsonl");
    fs.writeFileSync(file, '{"old":true}\n');
    const original = fs.statSync(file);
    fs.writeFileSync(file, '{"new":true}\n');
    const records = [];
    const result = readJsonlIncremental({
      filePath: file,
      startOffset: 999,
      discardingLine: false,
      expectedIdentity: `${original.dev}:${original.ino}`,
      ...LIMITS,
      onRecord: (record) => records.push(record)
    });
    assert.deepEqual(records, [{ new: true }]);
    assert.equal(result.nextOffset, fs.statSync(file).size);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a fully consumed source reports no backlog at exact byte or line limits", () => {
  const root = temporaryRoot();
  try {
    const file = path.join(root, "events.jsonl");
    fs.writeFileSync(file, '{"ok":true}\n');
    const size = fs.statSync(file).size;
    const byteLimited = readJsonlIncremental({
      filePath: file,
      startOffset: 0,
      discardingLine: false,
      expectedIdentity: null,
      ...LIMITS,
      maximumBytes: size,
      onRecord() {}
    });
    assert.equal(byteLimited.nextOffset, size);
    assert.equal(byteLimited.hasBacklog, false);
    const lineLimited = readJsonlIncremental({
      filePath: file,
      startOffset: 0,
      discardingLine: false,
      expectedIdentity: null,
      ...LIMITS,
      maximumLines: 1,
      onRecord() {}
    });
    assert.equal(lineLimited.nextOffset, size);
    assert.equal(lineLimited.hasBacklog, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
