import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compact, reductionRatio } from '../src/compact.mjs';

const filler = (n) =>
  Array.from({ length: n }, (_, i) => [
    { role: 'assistant', text: `working on step ${i}`, toolUses: [] },
    { role: 'user', text: 'ok', toolUses: [], toolResults: [] },
  ]).flat();

const call = (id, tool, input) => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] });
const result = (id, text, isError = false) => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text, isError }],
});

// a result long enough to be worth scoring, built around words nothing else in the test uses
const dump = (words) => `${words.join(' ')} ${'padding '.repeat(120)}`;

const conversation = () => [
  { role: 'user', text: 'fix the totals', toolUses: [], toolResults: [] },
  call('a', 'Read', { path: '/proj/src/alpha_module.ts' }),
  result('a', dump(['computeAlphaTotals', 'alpha_module_widget', 'AlphaLedgerRow'])),
  call('b', 'Bash', { command: 'ls build' }),
  result('b', dump(['zeta_unused_marker', 'frobnicate_qux_handler', 'ZetaOutputBundle'])),
  { role: 'assistant', text: 'The bug is in computeAlphaTotals; alpha_module_widget skips AlphaLedgerRow.', toolUses: [] },
  ...filler(12),
];

test('results the assistant never used again are dropped before ones it kept using', async () => {
  const out = await compact(conversation(), null, { dropFraction: 0.5, preserveRecentMessages: 6 });
  const byId = new Map(out.decisions.map((d) => [d.id, d]));
  const dropped = out.decisions.filter((d) => d.action === 'drop_result').map((d) => d.id);
  assert.equal(dropped.length, 1);
  const unusedCallId = out.decisions.find((d) => d.tool === 'Bash').id;
  assert.deepEqual(dropped, [unusedCallId]);
  assert.ok(byId.size === 2);
  assert.ok(reductionRatio(out) > 0.2, 'dropping the unused dump frees real space');
});

test('nothing is dropped when dropFraction is 0', async () => {
  const out = await compact(conversation(), null, { dropFraction: 0 });
  assert.equal(out.decisions.filter((d) => d.action !== 'keep').length, 0);
});

test('short results are never scored', async () => {
  const messages = conversation();
  messages[2] = result('a', 'short');
  messages[4] = result('b', 'short');
  const out = await compact(messages, null, {});
  assert.equal(out.decisions.filter((d) => d.action !== 'keep').length, 0);
});

test('a result with too few distinctive words to judge is left alone', async () => {
  const messages = conversation();
  messages[4] = result('b', 'x '.repeat(600));
  const out = await compact(messages, null, { dropFraction: 1 });
  const bash = out.decisions.find((d) => d.tool === 'Bash');
  assert.equal(bash.action, 'keep');
});

test('compact escalates until the target reduction is met', async () => {
  const { compact, reductionRatio } = await import('../src/compact.mjs');
  const messages = [{ role: 'user', text: 'start', toolUses: [] }];
  for (let i = 0; i < 12; i++) {
    const word = `module_${i}_alpha module_${i}_beta module_${i}_gamma`;
    messages.push({ role: 'assistant', text: `look at ${word}`, toolUses: [{ tool_use_id: `u${i}`, tool: 'Bash', input: { command: `cat file${i}` } }] });
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${i}`, text: `${word} `.repeat(120) }] });
  }
  for (let i = 0; i < 6; i++) messages.push({ role: 'assistant', text: 'later talk', toolUses: [] });
  const first = await compact(messages, null, { targetReduction: 0 });
  const pushed = await compact(messages, null, { targetReduction: 0.9 });
  assert.equal(first.stats.escalations, 0);
  assert.ok(pushed.stats.escalations > 0);
  assert.ok(reductionRatio(pushed) > reductionRatio(first));
});

test('cut results and inputs are queued for saving and their markers name the file', async () => {
  const { compact } = await import('../src/compact.mjs');
  const messages = [{ role: 'user', text: 'start', toolUses: [] }];
  for (let i = 0; i < 6; i++) {
    const word = `module_${i}_alpha module_${i}_beta module_${i}_gamma`;
    messages.push({
      role: 'assistant',
      text: `look at ${word}`,
      toolUses: [{ tool_use_id: `u${i}`, tool: 'Write', input: { file_path: `f${i}`, content: 'y'.repeat(4000) } }],
    });
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${i}`, text: `${word} `.repeat(120) }] });
  }
  for (let i = 0; i < 6; i++) messages.push({ role: 'assistant', text: 'later talk', toolUses: [] });
  const pathFor = (kind, id) => `/saved/${id}-${kind}`;
  const result = await compact(messages, null, { dropFraction: 1, inputDropFraction: 1, pathFor, protectRecentMessages: 0 });
  const paths = result.saved.map((file) => file.path);
  assert.ok(paths.some((path) => path.endsWith('-result')));
  assert.ok(paths.some((path) => path.endsWith('-input')));
  const marked = result.messages.flatMap((m) => (m.toolResults ?? []).map((r) => r.text)).filter((t) => t.includes('thinwood truncated'));
  assert.ok(marked.length > 0);
  assert.ok(marked.every((text) => /saved to \/saved\/u\d+-result\]/.test(text)));
  const plain = await compact(messages, null, { dropFraction: 1, inputDropFraction: 1, protectRecentMessages: 0 });
  assert.equal(plain.saved.length, 0);
});

test('a pointer left by the trimmer survives a cut', async () => {
  const { compact } = await import('../src/compact.mjs');
  const pointer = '[… 90 lines / 7000 chars trimmed; full output saved to C:/x/trimmed-results/abc-0.txt …]';
  const text = `${'a'.repeat(1500)}\n${pointer}\n${'b'.repeat(1500)}`;
  const messages = [
    { role: 'user', text: 'start', toolUses: [] },
    { role: 'assistant', text: 'run it', toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: 'x' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text }] },
    ...Array.from({ length: 8 }, () => ({ role: 'assistant', text: 'later', toolUses: [] })),
  ];
  const cut = (await compact(messages, null, { dropFraction: 1, minResultChars: 100, truncateHeadChars: 100, protectRecentMessages: 0 })).messages;
  const kept = cut.flatMap((m) => (m.toolResults ?? []).map((r) => r.text)).join('');
  assert.match(kept, /full output saved to C:\/x\/trimmed-results\/abc-0\.txt\]/);
});

test('results among the latest messages are never dropped, even at full strength', async () => {
  const { compact } = await import('../src/compact.mjs');
  const messages = [{ role: 'user', text: 'start', toolUses: [] }];
  for (let i = 0; i < 8; i++) {
    const word = `module_${i}_alpha module_${i}_beta module_${i}_gamma`;
    messages.push({ role: 'assistant', text: `look at ${word}`, toolUses: [{ tool_use_id: `u${i}`, tool: 'Bash', input: { command: `cat f${i}` } }] });
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${i}`, text: `${word} `.repeat(120) }] });
  }
  for (let i = 0; i < 8; i++) messages.push({ role: 'assistant', text: 'later talk', toolUses: [] });
  const open = await compact(messages, null, { dropFraction: 1, protectRecentMessages: 0 });
  const guarded = await compact(messages, null, { dropFraction: 1, protectRecentMessages: 12 });
  assert.equal(open.stats.resultsDropped, 8);
  assert.ok(guarded.stats.resultsDropped < 8);
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function randomSession(seed) {
  let state = seed;
  const next = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const messages = [{ role: 'user', text: 'start', toolUses: [] }];
  const count = 10 + Math.floor(next() * 40);
  for (let i = 0; i < count; i++) {
    const word = `thing_${seed}_${i}_alpha thing_${seed}_${i}_beta thing_${seed}_${i}_gamma`;
    const tool = ['Bash', 'Read', 'Write', 'Edit'][Math.floor(next() * 4)];
    const input = tool === 'Write' ? { file_path: `f${i}`, content: 'c'.repeat(Math.floor(next() * 6000)) } : { command: `x ${i}` };
    messages.push({ role: 'assistant', text: next() < 0.5 ? `about ${word}` : '', toolUses: [{ tool_use_id: `u${seed}_${i}`, tool, input }] });
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${seed}_${i}`, text: `${word} `.repeat(Math.floor(next() * 150)), isError: next() < 0.1 }] });
  }
  for (let i = 0; i < 6; i++) messages.push({ role: 'assistant', text: 'closing', toolUses: [] });
  return messages;
}

test('compaction never mutates its input and never unpairs a tool call, on random sessions', async () => {
  const { compact, unpairedToolCalls } = await import('../src/compact.mjs');
  for (let seed = 1; seed <= 60; seed++) {
    const messages = deepFreeze(randomSession(seed));
    const result = await compact(messages, null, { targetReduction: 0.9, pathFor: (kind, id) => `/s/${id}-${kind}`, protectRecentMessages: 4 });
    assert.equal(unpairedToolCalls(result.messages), 0, `seed ${seed}`);
    assert.ok(result.messages.length <= messages.length);
  }
});

test('compacting twice cuts nothing more and saves nothing again', async () => {
  const { compact } = await import('../src/compact.mjs');
  const options = { dropFraction: 1, inputDropFraction: 1, protectRecentMessages: 0, pathFor: (kind, id) => `/s/${id}-${kind}` };
  const once = await compact(randomSession(7), null, options);
  const twice = await compact(once.messages, null, options);
  assert.equal(twice.saved.length, 0);
  assert.equal(twice.stats.charsAfter, twice.stats.charsBefore);
});

test('messages with no text or tool lists do not break compaction', async () => {
  const { compact } = await import('../src/compact.mjs');
  const messages = [
    { role: 'user', toolUses: [] },
    { role: 'assistant', text: 'x', toolUses: [{ tool_use_id: 'a', tool: 'Bash' }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a' }] },
    { role: 'assistant', text: 'look at big_identifier_one big_identifier_two' },
    ...Array.from({ length: 8 }, () => ({ role: 'assistant', text: 'later' })),
  ];
  const result = await compact(messages, null, { protectRecentMessages: 0 });
  assert.equal(result.messages.length, messages.length);
});

test('escalation drops only as much as the target needs', async () => {
  const { compact, reductionRatio } = await import('../src/compact.mjs');
  const messages = [{ role: 'user', text: 'start', toolUses: [] }];
  for (let i = 0; i < 20; i++) {
    const word = `module_${i}_alpha module_${i}_beta module_${i}_gamma`;
    messages.push({ role: 'assistant', text: `look at ${word}`, toolUses: [{ tool_use_id: `u${i}`, tool: 'Bash', input: { command: `cat file${i}` } }] });
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${i}`, text: `${word} `.repeat(120) }] });
  }
  for (let i = 0; i < 6; i++) messages.push({ role: 'assistant', text: 'later talk', toolUses: [] });
  const options = { protectRecentMessages: 0, dropFraction: 0.2, inputDropFraction: 0 };
  const base = reductionRatio(await compact(messages, null, options));
  const target = base + 0.15;
  const result = await compact(messages, null, { ...options, targetReduction: target });
  assert.ok(reductionRatio(result) >= target);
  assert.ok(result.stats.dropFraction > 0.2 && result.stats.dropFraction < 1, String(result.stats.dropFraction));
});
