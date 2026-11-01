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
  // a single line longer than this (minified JSON, base64, a one-line log) keeps its start only
  maxLineChars: 1200,
  lineHeadChars: 800,
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

function clipLongLines(lines, maxChars, headChars) {
  let clipped = 0;
  const out = lines.map((line) => {
    if (line.length <= maxChars) return line;
    clipped++;
    return `${line.slice(0, headChars)}[… ${line.length - headChars} more chars on this line]`;
  });
  return { lines: out, clipped };
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
 * Returns { text, changed, lossy, droppedChars, droppedLines }.
 * Results at or under the threshold come back untouched. Errors get a larger
 * allowance before anything is cut. `lossy` means text beyond ANSI codes and
 * repeated lines was cut, so the caller should save the original.
 */
export function trimText(original, options = {}, { isError = false, savedTo } = {}) {
  const o = { ...TRIM_DEFAULTS, ...options };
  const limit = isError ? o.thresholdChars * o.errorMultiplier : o.thresholdChars;
  const untouched = { text: original, changed: false, lossy: false, droppedChars: 0, droppedLines: 0 };
  if (original.length <= limit) return untouched;

  const where = savedTo ? `; full output saved to ${savedTo}` : '';
  const folded = collapseRepeats(dropProgressAndAnsi(original).split('\n'));
  const { lines, clipped } = clipLongLines(folded, o.maxLineChars, o.lineHeadChars);
  const note = clipped > 0 ? `\n[thinwood: ${clipped} long line(s) clipped${where}]` : '';
  const cleaned = lines.join('\n') + note;
  const finish = (text, droppedLines) => ({
    text,
    changed: text.length < original.length,
    lossy: clipped > 0 || droppedLines > 0,
    droppedChars: Math.max(0, original.length - text.length),
    droppedLines,
  });
  if (cleaned.length <= limit) return finish(cleaned, 0);

  const headN = takeFromStart(lines, o.headChars);
  const tailN = takeFromEnd(lines, o.tailChars, headN);
  const middle = lines.slice(headN, lines.length - tailN);
  if (middle.length === 0) return finish(cleaned, 0);

  const signal = middle.filter((l) => SIGNAL.test(l)).slice(0, o.maxSignalLines).map((l) => (l.length > 240 ? `${l.slice(0, 237)}...` : l));
  const droppedChars = middle.reduce((s, l) => s + l.length + 1, 0);
  const parts = [lines.slice(0, headN).join('\n')];
  parts.push(`[… ${middle.length} lines / ${droppedChars} chars trimmed${where} …]`);
  if (signal.length) parts.push(`[error/warning lines from the trimmed part:]`, ...signal, `[… end of extracted lines …]`);
  parts.push(lines.slice(lines.length - tailN).join('\n'));
  return finish(parts.join('\n'), middle.length);
}
