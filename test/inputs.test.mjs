import assert from 'node:assert/strict';
import { test } from 'node:test';
import { truncateInputs } from '../src/inputs.mjs';

const big = (n) => 'x'.repeat(n);
const use = (id, input) => ({ tool_use_id: id, tool: 'Write', input });
const msg = (toolUses) => ({ role: 'assistant', text: '', toolUses });
const options = { minInputChars: 1000, inputDropFraction: 1, truncateHeadChars: 50, preserveRecentMessages: 1 };

test('a long field is cut but short fields and the tool name stay', () => {
  const messages = [msg([]), msg([use('a', { file_path: '/a.txt', content: big(5000) })]), msg([])];
  const { messages: out, truncated, freedChars } = truncateInputs(messages, options);
  assert.equal(truncated, 1);
  assert.equal(freedChars, 5000);
  const input = out[1].toolUses[0].input;
  assert.equal(input.file_path, '/a.txt');
  assert.ok(input.content.length < 200);
  assert.match(input.content, /thinwood truncated 4950 chars/);
});

test('recent and first messages are never touched', () => {
  const messages = [msg([use('a', { content: big(5000) })]), msg([use('b', { content: big(5000) })])];
  assert.equal(truncateInputs(messages, options).truncated, 0);
});

test('oldest inputs go first when only a share is dropped', () => {
  const messages = [
    msg([]),
    msg([use('a', { content: big(4000) })]),
    msg([use('b', { content: big(4000) })]),
    msg([]),
  ];
  const { messages: out } = truncateInputs(messages, { ...options, inputDropFraction: 0.5 });
  assert.ok(out[1].toolUses[0].input.content.length < 200);
  assert.equal(out[2].toolUses[0].input.content.length, 4000);
});

test('nested fields in arrays are cut and the original is not mutated', () => {
  const edits = [{ old_string: big(3000), new_string: 'ok' }];
  const messages = [msg([]), msg([use('a', { edits })]), msg([])];
  const { messages: out } = truncateInputs(messages, options);
  assert.ok(out[1].toolUses[0].input.edits[0].old_string.length < 200);
  assert.equal(out[1].toolUses[0].input.edits[0].new_string, 'ok');
  assert.equal(edits[0].old_string.length, 3000);
});

test('a zero fraction changes nothing', () => {
  const messages = [msg([]), msg([use('a', { content: big(5000) })]), msg([])];
  assert.equal(truncateInputs(messages, { ...options, inputDropFraction: 0 }).messages, messages);
});

test('inputs of tools whose work is on disk go before a command, whatever the age', () => {
  const messages = [
    msg([]),
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c', tool: 'Bash', input: { command: big(4000) } }] },
    msg([use('w', { content: big(4000) })]),
    msg([]),
  ];
  const { messages: out } = truncateInputs(messages, { ...options, inputDropFraction: 0.5 });
  assert.ok(out[2].toolUses[0].input.content.length < 200);
  assert.equal(out[1].toolUses[0].input.command.length, 4000);
});
