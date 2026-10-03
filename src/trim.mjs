// Pure helpers for shrinking large tool results before the model keeps them.
// No I/O: the hook saves the original to disk and passes the path in.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const SIGNAL = /\b(error|fail(ed|ure|ing)?|fatal|exception|traceback|panic|denied|unhandled|cannot|could not|not found|timed? ?out|assert(ion)?|warn(ing)?)\b/i;

export const TRIM_DEFAULTS = {
  thresholdChars: 6000,
  headChars: 2000,
  tailChars: 1500,
  maxSignalLines: 25,
  errorMultiplier: 3,
};

function dropProgressAndAnsi(text) {
  const stripped = text.replace(ANSI, '');
  if (!stripped.includes('\r')) return stripped;
  return stripped
    .split('\n')
    .map((line) => (line.includes('\r') ? (line.split('\r').filter(Boolean).pop() ?? '') : line))
    .join('\n');
}

function collapseRepeats(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    out.push(lines[i]);
    if (run >= 4) out.push(`[… previous line repeated ${run - 1} more times]`);
    else for (let k = 1; k < run; k++) out.push(lines[i]);
    i = j;
  }
  return out;
}

function takeFromStart(lines, budget) {
  let used = 0;
  let n = 0;
  while (n < lines.length && used + lines[n].length + 1 <= budget) used += lines[n++].length + 1;
  return n;
}

function takeFromEnd(lines, budget, floor) {
  let used = 0;
  let n = 0;
  while (lines.length - n - 1 >= floor && used + lines[lines.length - 1 - n].length + 1 <= budget) {
    used += lines[lines.length - 1 - n].length + 1;
    n++;
  }
  return n;
}

/**
 * Returns { text, changed, droppedChars, droppedLines }.
 * Results at or under the threshold come back untouched. Errors get a larger
 * allowance before anything is cut.
 */
export function trimText(original, options = {}, { isError = false, savedTo } = {}) {
  const o = { ...TRIM_DEFAULTS, ...options };
  const limit = isError ? o.thresholdChars * o.errorMultiplier : o.thresholdChars;
  if (original.length <= limit) return { text: original, changed: false, droppedChars: 0, droppedLines: 0 };

  const lines = collapseRepeats(dropProgressAndAnsi(original).split('\n'));
  const cleaned = lines.join('\n');
  if (cleaned.length <= limit) {
    return { text: cleaned, changed: cleaned.length < original.length, droppedChars: original.length - cleaned.length, droppedLines: 0 };
  }

  const headN = takeFromStart(lines, o.headChars);
  const tailN = takeFromEnd(lines, o.tailChars, headN);
  const middle = lines.slice(headN, lines.length - tailN);
  if (middle.length === 0) return { text: cleaned, changed: cleaned.length < original.length, droppedChars: original.length - cleaned.length, droppedLines: 0 };

  const signal = middle.filter((l) => SIGNAL.test(l)).slice(0, o.maxSignalLines).map((l) => (l.length > 240 ? `${l.slice(0, 237)}...` : l));
  const droppedChars = middle.reduce((s, l) => s + l.length + 1, 0);
  const where = savedTo ? `; full output saved to ${savedTo}` : '';
  const parts = [lines.slice(0, headN).join('\n')];
  parts.push(`[… ${middle.length} lines / ${droppedChars} chars trimmed${where} …]`);
  if (signal.length) parts.push(`[error/warning lines from the trimmed part:]`, ...signal, `[… end of extracted lines …]`);
  parts.push(lines.slice(lines.length - tailN).join('\n'));
  const text = parts.join('\n');
  return { text, changed: true, droppedChars: Math.max(0, original.length - text.length), droppedLines: middle.length };
}
