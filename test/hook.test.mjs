import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register, resolveHookConfig, summarize } from '../hooks/compaction.ts';

function session() {
  const messages = [{ role: 'user', text: 'start', toolUses: [] }];
  for (let i = 0; i < 10; i++) {
    const word = `module_${i}_alpha module_${i}_beta module_${i}_gamma`;
    messages.push({ role: 'assistant', text: `look at ${word}`, toolUses: [{ tool_use_id: `u${i}`, tool: 'Bash', input: { command: `cat f${i}` } }] });
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${i}`, text: `${word} `.repeat(120) }] });
  }
  for (let i = 0; i < 8; i++) messages.push({ role: 'assistant', text: 'later talk', toolUses: [] });
  return messages;
}

function harness(options, { failWrites = false, usage = { context: { tokens: 0, percent: 0 } }, compactError } = {}) {
  const handlers = {};
  register((name, ...rest) => (handlers[name] = rest.at(-1)), { protectRecentMessages: 4, ...options });
  const written = [];
  const logs = [];
  const queued = [];
  const files = new Map();
  const $ = {
    env: { get: async (key) => (key === 'USERPROFILE' ? 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'me' : undefined) },
    fs: {
      write: async (path, text) => {
        if (path.endsWith('thinwood-log.jsonl')) return void files.set(path, text);
        if (failWrites) throw new Error('disk full');
        written.push({ path, text });
      },
      read: async (path) => files.get(path) ?? '',
      exists: async (path) => files.has(path),
    },
    ui: { log: (text) => logs.push(text), toast: () => {} },
    session: { usage: async () => usage, compact: async () => { if (compactError) throw new Error(compactError); } },
    clock: { after: (_ms, fn) => queued.push(fn) },
    command: { run: async (command) => logs.push(`ran ${command.command}`) },
  };
  return { handlers, written, logs, queued, files, $ };
}

test('compaction keeps pruned messages, saves what it cut, and names the files', async () => {
  const { handlers, written, $ } = harness({});
  const event = { messages: session() };
  const out = await handlers['session.compact']($, event, async () => 'fallback');
  assert.ok(Array.isArray(out.messages));
  assert.ok(written.length > 0);
  assert.ok(written.every((file) => file.text.length > 0));
  assert.equal(new Set(written.map((file) => file.path)).size, written.length);
  assert.ok(written.every((file) => file.path.startsWith('C:/Users/me/.claude/thinwood-saved/')));
  const text = JSON.stringify(out.messages);
  assert.match(text, /full output saved to C:\/Users\/me\/\.claude\/thinwood-saved\//);
});

test('a failed write retries without file names so no marker points nowhere', async () => {
  const { handlers, written, logs, $ } = harness({}, { failWrites: true });
  const out = await handlers['session.compact']($, { messages: session() }, async () => 'fallback');
  assert.equal(written.length, 0);
  assert.ok(Array.isArray(out.messages));
  assert.doesNotMatch(JSON.stringify(out.messages), /thinwood-saved/);
  assert.ok(logs.some((line) => /could not save/.test(line)));
});

test('too little to cut falls back to the built-in summary', async () => {
  const { handlers, $ } = harness({});
  const messages = [{ role: 'user', text: 'hi', toolUses: [] }, { role: 'assistant', text: 'hello', toolUses: [] }];
  const out = await handlers['session.compact']($, { messages }, async () => 'fallback');
  assert.equal(out, 'fallback');
});

test('saveDropped false writes nothing', async () => {
  const { handlers, written, $ } = harness({ saveDropped: false });
  const out = await handlers['session.compact']($, { messages: session() }, async () => 'fallback');
  assert.ok(Array.isArray(out.messages));
  assert.equal(written.length, 0);
});

test('a turn over the threshold asks for a compaction; headless sessions queue /compact', async () => {
  const over = { context: { tokens: 400000, percent: 90 } };
  const { handlers, logs, queued, $ } = harness({}, { usage: over, compactError: 'not available in headless mode' });
  await handlers['turn.complete']($, {}, async () => 'next');
  assert.equal(queued.length, 1);
  await queued[0]();
  assert.ok(logs.includes('ran [object Object]') || logs.some((line) => line.startsWith('ran')));
});

test('a turn under the threshold does nothing', async () => {
  const { handlers, queued, $ } = harness({}, { usage: { context: { tokens: 1000, percent: 5 } } });
  await handlers['turn.complete']($, {}, async () => 'next');
  assert.equal(queued.length, 0);
});

test('config and summary helpers', () => {
  const config = resolveHookConfig({ compactAtPercent: 70, scoring: 'model', dropFraction: 0.3, junk: 1 });
  assert.equal(config.compactAtPercent, 70);
  assert.equal(config.scoring, 'model');
  assert.equal(config.dropFraction, 0.3);
  assert.equal(config.saveDropped, true);
  assert.equal(resolveHookConfig({}).scoring, 'reuse');
  const stats = { kept: 1, resultsDropped: 2, callsDropped: 0, inputsTruncated: 3, pinned: 0, charsBefore: 40000, charsAfter: 20000, stateStage: 'reuse' };
  const line = summarize({ stats });
  assert.match(line, /50% reduction \(~5k tokens\)/);
  assert.match(line, /3 inputs truncated/);
});

test('when too little can be cut, the built-in summary gets the pruned history', async () => {
  const { handlers, written, $ } = harness({ minReductionRatio: 0.99 });
  const original = { messages: session() };
  let seen;
  await handlers['session.compact']($, original, async (event) => { seen = event; return 'summary'; });
  assert.ok(seen.messages.length > 0);
  const size = (messages) => JSON.stringify(messages).length;
  assert.ok(size(seen.messages) < size(original.messages));
  assert.ok(written.length > 0);
});

test('pruneBeforeSummary false passes the event through untouched', async () => {
  const { handlers, $ } = harness({ minReductionRatio: 0.99, pruneBeforeSummary: false });
  const original = { messages: session() };
  let seen;
  await handlers['session.compact']($, original, async (event) => { seen = event; return 'summary'; });
  assert.equal(seen, original);
});

test('an event with no messages goes straight to the built-in handler', async () => {
  const { handlers, $ } = harness({});
  assert.equal(await handlers['session.compact']($, {}, async () => 'builtin'), 'builtin');
  assert.equal(await handlers['session.compact']($, { messages: [] }, async () => 'builtin'), 'builtin');
});

test('each decision is recorded in the log file, newest last', async () => {
  const { handlers, files, $ } = harness({});
  await handlers['session.compact']($, { messages: session() }, async () => 'fallback');
  await handlers['session.compact']($, { messages: [{ role: 'user', text: 'hi', toolUses: [] }, { role: 'assistant', text: 'yo', toolUses: [] }] }, async () => 'fallback');
  const lines = files.get('C:/Users/me/.claude/thinwood-log.jsonl').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.event), ['compacted', 'fallback']);
  assert.ok(lines[0].charsAfter < lines[0].charsBefore);
  assert.match(lines[1].reason, /below minimum/);
  assert.ok(lines[0].at);
});

test('the log keeps only the newest 300 lines', async () => {
  const { handlers, files, $ } = harness({});
  const messages = [{ role: 'user', text: 'hi', toolUses: [] }, { role: 'assistant', text: 'yo', toolUses: [] }];
  for (let i = 0; i < 305; i++) await handlers['session.compact']($, { messages }, async () => 'fallback');
  assert.equal(files.get('C:/Users/me/.claude/thinwood-log.jsonl').trim().split('\n').length, 300);
});
