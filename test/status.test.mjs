import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readLog, summarizeLog } from '../scripts/status.mjs';

test('the log is read leniently and summarised', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinwood-status-'));
  const file = path.join(dir, 'log.jsonl');
  const lines = [
    { event: 'trigger', tokens: 400000, percent: 90 },
    { event: 'compacted', charsBefore: 4000000, charsAfter: 2000000, at: '2026-11-01T10:00:00Z' },
    { event: 'fallback', reason: 'below minimum', at: '2026-11-01T11:00:00Z' },
    { event: 'fallback', reason: 'below minimum' },
    { event: 'fallback', reason: 'timeout' },
  ].map((entry) => JSON.stringify(entry));
  fs.writeFileSync(file, `${lines.join('\n')}\nnot json\n`);
  const entries = readLog(file);
  assert.equal(entries.length, 5);
  const summary = summarizeLog(entries);
  assert.equal(summary.triggers, 1);
  assert.equal(summary.compacted, 1);
  assert.equal(summary.fallbacks, 3);
  assert.equal(summary.freedTokens, 500000);
  assert.deepEqual(summary.reasons[0], ['below minimum', 2]);
  assert.equal(summary.lastCompacted, '2026-11-01T10:00:00Z');
  assert.deepEqual(readLog(path.join(os.tmpdir(), 'does-not-exist.jsonl')), []);
  fs.rmSync(dir, { recursive: true });
});
