import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchCalls, compact, decideCall } from '../src/compact.mjs';
import { ollamaAsker } from '../src/ollama-asker.mjs';
import { collectToolCalls, estimateTokens, fitState, goalFromMessages, isPinned } from '../src/state.mjs';

const fakeFetch = (reply, seen = []) => async (url, init) => {
  seen.push({ url, body: init?.body ? JSON.parse(init.body) : null });
  return { ok: true, status: 200, text: async () => '', json: async () => reply };
};

function session(count) {
  const messages = [{ role: 'user', text: 'fix the build', toolUses: [] }];
  for (let i = 0; i < count; i++) {
    messages.push({ role: 'assistant', text: `step ${i}`, toolUses: [{ tool_use_id: `u${i}`, tool: 'Bash', input: { command: `run ${i}` } }] });
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${i}`, text: `output ${i} `.repeat(200) }] });
  }
  for (let i = 0; i < 8; i++) messages.push({ role: 'assistant', text: 'wrapping up', toolUses: [] });
  return messages;
}

test('the asker sends short aliases, a schema, a sized context and maps answers back', async () => {
  const seen = [];
  const reply = { message: { content: JSON.stringify({ answers: { q1: { noul: 0.2 }, q2: { noul: 0.9 } } }) } };
  const asker = ollamaAsker({ fetch: fakeFetch(reply, seen), numCtx: 8192 });
  const out = await asker.ask({ history: [] }, { call_t1: { type: 'noul', instructions: 'a' }, result_t1: { type: 'noul', instructions: 'b' } });
  assert.deepEqual(out.answers, { call_t1: { noul: 0.2 }, result_t1: { noul: 0.9 } });
  const body = seen[0].body;
  assert.equal(body.options.num_ctx, 8192);
  assert.equal(body.options.temperature, 0);
  assert.equal(body.options.num_predict, 2 * 20 + 80);
  assert.deepEqual(Object.keys(JSON.parse(body.messages[1].content).questions), ['q1', 'q2']);
});

test('the asker rejects an out-of-range or missing answer, and a failed request', async () => {
  const bad = { message: { content: JSON.stringify({ answers: { q1: { noul: 7 } } }) } };
  await assert.rejects(ollamaAsker({ fetch: fakeFetch(bad) }).ask({}, { x: {} }), /no valid answer for x/);
  const failing = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(ollamaAsker({ fetch: failing }).ask({}, { x: {} }), /failed \(500\)/);
  await assert.rejects(ollamaAsker({ fetch: failing }).warm(), /warm-up failed/);
});

test('the asker recovers JSON wrapped in prose', async () => {
  const wrapped = { message: { content: `Sure! ${JSON.stringify({ answers: { q1: { noul: 0.4 } } })} Done.` } };
  const out = await ollamaAsker({ fetch: fakeFetch(wrapped) }).ask({}, { x: {} });
  assert.equal(out.answers.x.noul, 0.4);
});

test('model scoring: low scores truncate results, one request per batch, uniform scores abort', async () => {
  const messages = session(6);
  const asker = {
    asked: 0,
    async ask(_state, questions) {
      this.asked++;
      const answers = {};
      Object.keys(questions).forEach((id, i) => (answers[id] = { noul: id.startsWith('call_') ? 0.9 : i % 4 === 1 ? 0.1 : 0.9 }));
      return { answers };
    },
  };
  const result = await compact(messages, asker, { scoring: 'model', minResultChars: 100, preserveRecentMessages: 3 });
  assert.ok(result.stats.resultsDropped > 0);
  assert.equal(result.stats.requests, asker.asked);

  const flat = { ask: async (_s, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { noul: 1 }])) }) };
  await assert.rejects(compact(messages, flat, { scoring: 'model', minResultChars: 100, preserveRecentMessages: 3 }), /nearly the same score/);
});

test('batches respect the per-request call cap and the token budget', () => {
  const calls = collectToolCalls(session(30), 3);
  const batches = batchCalls(calls, 1000, { maxRequestTokens: 12000, maxCallsPerRequest: 7 });
  assert.ok(batches.every((batch) => batch.length <= 7));
  assert.equal(batches.flat().length, calls.length);
  assert.throws(() => batchCalls(calls, 11990, { maxRequestTokens: 12000 }), /no room for questions/);
});

test('decideCall: pinned stays, high result score stays, low scores truncate or drop the call', () => {
  const opts = { keepThreshold: 0.5 };
  assert.equal(decideCall({ id: 't1', tool: 'x', pinned: true }, { keepCall: 0, keepResult: 0 }, opts).action, 'keep');
  assert.equal(decideCall({ id: 't1', tool: 'x' }, { keepCall: 0, keepResult: 0.8 }, opts).action, 'keep');
  assert.equal(decideCall({ id: 't1', tool: 'x' }, { keepCall: 0.9, keepResult: 0.1 }, opts).action, 'drop_result');
  assert.equal(decideCall({ id: 't1', tool: 'x' }, { keepCall: 0.1, keepResult: 0.1 }, opts).action, 'drop_call');
});

test('fitState shrinks a long history to its budget in stages', () => {
  const messages = session(60);
  const calls = collectToolCalls(messages, 6);
  const fitted = fitState(messages, calls, { maxStateTokens: 5000, preserveRecentMessages: 6 });
  assert.ok(fitted.tokens <= 5000);
  assert.notEqual(fitted.stage, 'full');
  assert.ok(fitted.state.history.length > 0);
  assert.equal(fitState(messages, calls, { maxStateTokens: 100000, preserveRecentMessages: 6 }).stage, 'full');
  assert.throws(() => fitState(messages, calls, { maxStateTokens: 300, preserveRecentMessages: 6 }), /history too large/);
});

test('state helpers: token estimate, pinning, goal from the latest user messages', () => {
  assert.ok(estimateTokens('hello world 12345') > 3);
  assert.equal(isPinned(0, 100, 6), true);
  assert.equal(isPinned(50, 100, 6), false);
  assert.equal(isPinned(95, 100, 6), true);
  assert.match(goalFromMessages(session(2)), /fix the build/);
});
