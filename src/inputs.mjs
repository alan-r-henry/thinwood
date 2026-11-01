// Shrinks big string fields in old tool calls' inputs: the body of a Write, the old and new text
// of an Edit, a long heredoc in a Bash command. On real sessions inputs are a fifth to a half of
// all the text, and what they wrote is on disk or its effect is in the result that followed.
// The tool name, the short fields (paths, flags) and the start of each long field stay, so the
// call still reads as what it was.

import { isPinned } from './state.mjs';

const MAX_DEPTH = 3;
// what these tools wrote is in the file on disk, so cutting it from the history loses the least
const RECOVERABLE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function longStrings(value, minChars, depth, found) {
  if (typeof value === 'string') {
    if (value.length >= minChars) found.push(value.length);
  } else if (depth < MAX_DEPTH && value && typeof value === 'object') {
    for (const child of Object.values(value)) longStrings(child, minChars, depth + 1, found);
  }
  return found;
}

function shrink(value, minChars, headChars, depth, savedTo) {
  if (typeof value === 'string') {
    if (value.length < minChars) return value;
    const head = value.slice(0, headChars);
    const where = savedTo ? `; the whole input is saved to ${savedTo}` : '';
    return `${head}\n[thinwood truncated ${value.length - headChars} chars of this tool input${where}]`;
  }
  if (depth >= MAX_DEPTH || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((child) => shrink(child, minChars, headChars, depth + 1, savedTo));
  const copy = {};
  for (const [key, child] of Object.entries(value)) copy[key] = shrink(child, minChars, headChars, depth + 1, savedTo);
  return copy;
}

/**
 * Returns { messages, truncated, freedChars }. Inputs of tools whose work is on disk (Write,
 * Edit) go first, oldest first, then the rest, until `inputDropFraction` of all the long input
 * text outside the pinned messages is gone. With `save` ({ pathFor, saved }) each cut call's whole
 * input is queued in save.saved as JSON for the caller to write, and the marker names it.
 */
export function truncateInputs(messages, options, save) {
  const minChars = options.minInputChars ?? 1500;
  const fraction = options.inputDropFraction ?? 0.7;
  const headChars = options.truncateHeadChars ?? 300;
  if (fraction <= 0) return { messages, truncated: 0, freedChars: 0 };

  const eligible = [];
  let total = 0;
  messages.forEach((message, index) => {
    if (isPinned(index, messages.length, options.preserveRecentMessages)) return;
    message.toolUses.forEach((use, useIndex) => {
      const sizes = longStrings(use.input, minChars, 0, []);
      if (sizes.length === 0) return;
      const chars = sizes.reduce((sum, n) => sum + n, 0);
      eligible.push({ index, useIndex, chars, recoverable: RECOVERABLE.has(use.tool) });
      total += chars;
    });
  });

  // recoverable inputs first, each group oldest first
  eligible.sort((a, b) => Number(b.recoverable) - Number(a.recoverable) || a.index - b.index);
  const chosen = new Map();
  let freed = 0;
  for (const item of eligible) {
    if (freed >= fraction * total) break;
    freed += item.chars;
    chosen.set(`${item.index}:${item.useIndex}`, true);
  }
  if (chosen.size === 0) return { messages, truncated: 0, freedChars: 0 };

  const out = messages.map((message, index) => {
    if (!message.toolUses.some((_, useIndex) => chosen.has(`${index}:${useIndex}`))) return message;
    const toolUses = message.toolUses.map((use, useIndex) => {
      if (!chosen.has(`${index}:${useIndex}`)) return use;
      const path = save?.pathFor?.('input', use.tool_use_id);
      if (path) save.saved.push({ path, text: JSON.stringify(use.input, null, 2) });
      return { ...use, input: shrink(use.input, minChars, headChars, 0, path) };
    });
    return { ...message, toolUses };
  });
  return { messages: out, truncated: chosen.size, freedChars: freed };
}
