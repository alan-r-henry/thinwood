// Scores old tool results by how the assistant has actually used them, with no model.
//
// A result is "used" in a later assistant message when that message (its text, or the
// input of a different tool call) repeats at least two distinctive tokens from the
// result: a path, an identifier, an error string. Results that were last used long
// ago, were never used again, are big and not a failure are the cheapest to drop;
// the assistant can always re-run the tool.
//
// On six of the author's own sessions plus one 19,000-message session, ranking this way
// and freeing half of all old result text lost about 8% of the results the assistant went
// on to reuse (random lost 50%, size alone 9% by count but 34% by text, age alone 40%).

const TOKEN = /[a-z_][a-z0-9_.:/-]{5,}/g;
const TRAILING = /[.:/-]+$/;
const MAX_RESULT_CHARS_SCANNED = 200_000;
const MAX_ANCHORS = 40;
const MIN_HITS = 2;

function tokensOf(text) {
  const found = new Set();
  for (const [token] of text.toLowerCase().matchAll(TOKEN)) found.add(token.replace(TRAILING, ''));
  return found;
}

function callKey(tool, input) {
  try {
    return `${tool}${JSON.stringify(input)}`;
  } catch {
    return `${tool}?`;
  }
}

function resultTextOf(messages, call) {
  const found = (messages[call.resultIndex]?.toolResults ?? []).find(
    (result) => result.tool_use_id === call.tool_use_id,
  );
  return found?.text ?? '';
}

// Where the assistant wrote or did something with each wanted token: token -> [[message index,
// key of the tool call that carried it or null for text]]. Only tokens in `wanted` are kept, so
// this stays small however long the session is.
function indexAuthored(messages, wanted) {
  const postings = new Map();
  const add = (token, j, key) => {
    let list = postings.get(token);
    if (!list) postings.set(token, (list = []));
    list.push([j, key]);
  };
  messages.forEach((message, j) => {
    if (message.role !== 'assistant') return;
    for (const token of tokensOf(message.text ?? '')) if (wanted.has(token)) add(token, j, null);
    for (const use of message.toolUses ?? []) {
      const key = callKey(use.tool, use.input);
      for (const token of tokensOf(callKey('', use.input))) if (wanted.has(token)) add(token, j, key);
    }
  });
  return postings;
}

// the messages from `from` on that use at least MIN_HITS of the anchors, as { count, last }
function usesOf(anchors, key, from, postings) {
  const hits = new Map();
  anchors.forEach((anchor, a) => {
    const seen = new Set();
    for (const [j, via] of postings.get(anchor) ?? []) {
      if (j < from || seen.has(j) || (via !== null && via === key)) continue;
      seen.add(j);
      hits.set(j, (hits.get(j) ?? 0) + 1);
    }
  });
  let count = 0;
  let last = -1;
  for (const [j, n] of hits) {
    if (n < MIN_HITS) continue;
    count++;
    if (j > last) last = j;
  }
  return { count, last };
}

/**
 * Ranks results by how droppable they are, most droppable first. `calls` come from
 * collectToolCalls. Calls it cannot judge (pinned, short, or too few distinctive tokens to tell
 * whether they were used) are left out and stay as they are. dropTop turns a ranking into a Map
 * of call id to { keepCall, keepResult } (keepResult 0 means drop the result), plus the figures
 * behind it; scoreByReuse does both.
 */
export function rankByReuse(messages, calls, options) {
  const minChars = options.minResultChars ?? 500;
  // results this close to the end are what the assistant is working with right now
  const recentFrom = messages.length - (options.protectRecentMessages ?? 24);

  const info = new Map();
  const tokenSets = [];
  for (const call of calls) {
    if (call.pinned || call.resultChars < minChars || call.resultIndex >= recentFrom) continue;
    const tokens = tokensOf(resultTextOf(messages, call).slice(0, MAX_RESULT_CHARS_SCANNED));
    info.set(call.id, { call, tokens, key: callKey(call.tool, call.input) });
    tokenSets.push(tokens);
  }

  // a token that turns up in many results (a common word) says nothing about one of them
  const frequency = new Map();
  for (const tokens of tokenSets) for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const maxFrequency = Math.max(5, Math.floor(calls.length * 0.02));

  const lastIndex = messages.length - 1;
  // the last time each exact call (same tool, same input) was made
  const lastCallOfKey = new Map();
  for (const call of calls) {
    const key = callKey(call.tool, call.input);
    lastCallOfKey.set(key, Math.max(lastCallOfKey.get(key) ?? -1, call.resultIndex));
  }

  const judged = [];
  const wanted = new Set();
  for (const entry of info.values()) {
    const anchors = [...entry.tokens]
      .filter((token) => frequency.get(token) <= maxFrequency)
      .sort((a, b) => frequency.get(a) - frequency.get(b))
      .slice(0, MAX_ANCHORS);
    entry.tokens = null;
    if (anchors.length < MIN_HITS) continue; // nothing to tell use from non-use: leave it alone
    for (const anchor of anchors) wanted.add(anchor);
    judged.push({ entry, anchors });
  }
  const postings = indexAuthored(messages, wanted);

  const scored = [];
  for (const { entry, anchors } of judged) {
    const { call } = entry;
    // the turn right after the result always reads it, so look from the one after
    const used = usesOf(anchors, entry.key, call.resultIndex + 2, postings);
    const timesUsed = used.count;
    const lastUsed = used.count > 0 ? used.last : call.resultIndex;
    const sinceUse = lastIndex - lastUsed;
    const superseded = (lastCallOfKey.get(entry.key) ?? -1) > call.resultIndex;
    const score =
      (Math.sqrt(call.resultChars) * Math.sqrt(sinceUse + 1)) / (1 + timesUsed) *
      (superseded ? 4 : 1) *
      (call.isError ? 0.3 : 1);
    scored.push({ id: call.id, chars: call.resultChars, score, timesUsed, sinceUse, superseded });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Answers for dropping the highest-scored results until `fraction` of their text is gone. */
export function dropTop(scored, fraction) {
  const total = scored.reduce((sum, item) => sum + item.chars, 0);
  const answers = new Map();
  let freed = 0;
  for (const item of scored) {
    const drop = freed < fraction * total;
    if (drop) freed += item.chars;
    answers.set(item.id, { keepCall: 1, keepResult: drop ? 0 : 1 });
  }
  return { answers, scored: scored.length, eligibleChars: total, freedChars: freed };
}

export function scoreByReuse(messages, calls, options) {
  return dropTop(rankByReuse(messages, calls, options), options.dropFraction ?? 0.5);
}
