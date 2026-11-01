import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pruneOlderThan } from '../scripts/prune-saved.mjs';

test('only files older than the cutoff go, and a dry run deletes nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thinwood-prune-'));
  const old = path.join(root, 'sub', 'old.txt');
  const fresh = path.join(root, 'fresh.txt');
  fs.mkdirSync(path.dirname(old));
  fs.writeFileSync(old, 'x'.repeat(10));
  fs.writeFileSync(fresh, 'y');
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, longAgo, longAgo);

  assert.deepEqual(pruneOlderThan(root, 14, { dryRun: true }), { files: 1, bytes: 10 });
  assert.ok(fs.existsSync(old));
  assert.deepEqual(pruneOlderThan(root, 14), { files: 1, bytes: 10 });
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh));
  assert.deepEqual(pruneOlderThan(path.join(root, 'missing'), 14), { files: 0, bytes: 0 });
  fs.rmSync(root, { recursive: true });
});
