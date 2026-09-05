import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { statSourcePath } from '../src/core/source-stat.mjs';
import { discoverJsonlFiles, readJsonlIncremental } from '../src/core/jsonl-reader.mjs';

test('discovery and open reads retain the same volume identity across append and replacement', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-file-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl');
  fs.writeFileSync(file, '{"n":1}\n');
  const discovered = discoverJsonlFiles([root]).files[0];
  const read = (options = {}) => readJsonlIncremental({
    filePath: file, maximumBytes: 1024, maximumLineBytes: 1024,
    maximumLines: 10, maximumDepth: 10, deadlineMs: Date.now() + 1000,
    onRecord: () => {}, ...options,
  });
  const first = read();
  assert.equal(discovered.fileIdentity, first.fileIdentity);
  fs.appendFileSync(file, '{"n":2}\n');
  const stat = statSourcePath(file);
  assert.equal(`${stat.dev}:${stat.ino}`, first.fileIdentity);
  const second = read({ expectedIdentity: first.fileIdentity, startOffset: first.nextOffset });
  assert.equal(second.recordsRead, 1);
  fs.renameSync(file, path.join(root, 'retired.jsonl'));
  fs.writeFileSync(file, '{"n":3}\n');
  const replacement = read({ expectedIdentity: first.fileIdentity, startOffset: second.nextOffset });
  assert.notEqual(replacement.fileIdentity, first.fileIdentity);
  assert.equal(replacement.recordsRead, 1);
});
