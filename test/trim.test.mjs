import test from 'node:test';
import assert from 'node:assert/strict';
import { trimText } from '../src/trim.mjs';

const opts = { thresholdChars: 4000, headChars: 1500, tailChars: 1200 };
const numbered = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i} ${'x'.repeat(40)}`).join('\n');

test('results at or under the threshold come back untouched', () => {
  const text = numbered(20);
  const r = trimText(text, opts);
  assert.equal(r.changed, false);
  assert.equal(r.text, text);
});

test('a large result keeps head and tail, cuts the middle, and names the saved file', () => {
  const text = numbered(400);
  const r = trimText(text, opts, { savedTo: 'C:/tmp/full.txt' });
  assert.equal(r.changed, true);
  assert.ok(r.text.length < text.length / 2);
  assert.ok(r.text.startsWith('line 0 '));
  assert.ok(r.text.trimEnd().endsWith(`line 399 ${'x'.repeat(40)}`));
  assert.match(r.text, /full output saved to C:\/tmp\/full\.txt/);
  assert.ok(r.droppedLines > 0);
});

test('error and warning lines from the cut middle are kept', () => {
  const lines = numbered(400).split('\n');
  lines[200] = 'FAILED tests/test_payments.py::test_rounding - AssertionError';
  lines[250] = 'WARNING: deprecated call';
  const r = trimText(lines.join('\n'), opts, { savedTo: 'p' });
  assert.match(r.text, /FAILED tests\/test_payments\.py::test_rounding/);
  assert.match(r.text, /WARNING: deprecated call/);
});

test('ANSI codes and carriage-return progress are stripped from trimmed output', () => {
  const noisy = `\x1b[32mok\x1b[0m\n` + 'progress 1%\rprogress 50%\rprogress 100%\n' + numbered(300);
  const r = trimText(noisy, opts, { savedTo: 'p' });
  assert.ok(!r.text.includes('\x1b['));
  assert.ok(!r.text.includes('progress 1%'));
  assert.match(r.text, /progress 100%/);
});

test('long runs of identical lines fold into one', () => {
  const text = `start\n${'same line\n'.repeat(900)}end`;
  const r = trimText(text, opts, { savedTo: 'p' });
  assert.match(r.text, /previous line repeated 899 more times/);
  assert.ok(r.text.length < 400);
});

test('error results get three times the allowance before anything is cut', () => {
  const text = numbered(150); // ~6.5k chars: over 4k, under 12k
  assert.equal(trimText(text, opts, { isError: false, savedTo: 'p' }).changed, true);
  assert.equal(trimText(text, opts, { isError: true, savedTo: 'p' }).changed, false);
});
