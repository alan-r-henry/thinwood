// Adapted from fast-jev-compaction (MIT, tamaratran/fast-jev-compaction),
// stripped of TypeScript. The only change from the original algorithm is the
// asker: instead of a JevClient calling api.typesafe.ai, any object with an
// async ask(state, questions) method works (see ollama-asker.mjs).

import { collectToolCalls, estimateTokens, fitState } from './state.mjs';

export const DEFAULT_OPTIONS = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  // sized so one request to a local 14B model (prefill plus a short JSON answer) fits the
  // plugin sandbox's 30 s limit on a mid-range GPU
  maxStateTokens: 8_000,
  maxRequestTokens: 12_000,
  truncateHeadChars: 300,
  // each call is two questions; more per request means more output tokens to wait for
  maxCallsPerRequest: 20,
  // results shorter than this are kept without asking: dropping them saves almost nothing
  minResultChars: 500,
  // the first request's scores must span at least this much, or scoring is abandoned
  minScoreSpread: 0.15,
};

const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options = {}) {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages)),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    maxCallsPerRequest: Math.max(
      1,
      Math.floor(finite(options.maxCallsPerRequest, DEFAULT_OPTIONS.maxCallsPerRequest)),
    ),
    minResultChars: Math.max(0, finite(options.minResultChars, DEFAULT_OPTIONS.minResultChars)),
    minScoreSpread: Math.max(0, finite(options.minScoreSpread, DEFAULT_OPTIONS.minScoreSpread)),
  };
}

export function questionsFor(call) {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

export function batchCalls(calls, stateTokens, options) {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches = [];
  let current = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (
      current.length > 0 &&
      (currentTokens + tokens > budget || current.length >= (options.maxCallsPerRequest ?? Infinity))
    ) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function noulAnswer(answers, name) {
  const answer = answers[name];
  if (!answer || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)) {
    throw new Error(`Invalid answer for ${name}`);
  }
  return answer.noul;
}

export function decideCall(call, answer, options) {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

function hasSpread(answers, minSpread) {
  const scores = [...answers.values()].flatMap((a) => [a.keepCall, a.keepResult]);
  if (scores.length < 10) return true;
  return Math.max(...scores) - Math.min(...scores) >= minSpread;
}

async function askBatch(asker, state, batch) {
  const questions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

function truncatedResultText(text, isError, headChars) {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[thinwood truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

export function applyDecisions(messages, decisions, calls, headChars) {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(tool.text ?? '', tool.isError ?? false, headChars);
        if ((tool.text ?? '') === text) return tool;
        const copy = { tool_use_id: tool.tool_use_id, tool: tool.tool, input: tool.input, text };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : { tool_use_id: result.tool_use_id, text, isError: result.isError };
      });
    if (
      !message.toolUses.some((tool) => actions.get(tool.tool_use_id) === 'drop_call') &&
      !(message.toolResults ?? []).some((result) => actions.get(result.tool_use_id) === 'drop_call') &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every((result, index) => result === message.toolResults?.[index])
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

export function messageChars(message) {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result) {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions, reason) {
  return decisions.filter((decision) => decision.reason === reason).length;
}

export async function compact(messages, asker, options = {}) {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter(
    (call) => !call.pinned && call.resultChars >= resolved.minResultChars,
  );
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted = { tokens: 0, stage: '' };
  let batches = [];
  const answers = new Map();
  if (candidates.length > 0) {
    const state = fitState(messages, calls, resolved);
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved);
    // one request at a time: a local server works through them in turn anyway, and a queued
    // request would spend its time limit waiting
    for (const [index, batch] of batches.entries()) {
      const map = await askBatch(asker, state.state, batch);
      for (const [id, answer] of map) answers.set(id, answer);
      // a model that scores every call the same can't tell what to drop; stop after the first
      // request instead of spending minutes of GPU time to learn the same thing
      if (index === 0 && !hasSpread(map, resolved.minScoreSpread)) {
        throw new Error('the local model gave every call nearly the same score, so it cannot tell what to drop');
      }
    }
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const kept = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars);
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      ms: Date.now() - started,
    },
  };
}
