// Shrinks large tool results before the session keeps them: ANSI and progress
// noise out, repeated lines folded, the middle cut with head, tail and any
// error lines kept. The full original is saved to disk and its path is left in
// the result, so nothing is lost. Never touches a result it cannot save.

import { trimText } from '../src/trim.mjs';

const DEFAULTS = { isEnabled: true, tools: 'Bash,PowerShell,Grep', thresholdChars: 4000, isVerbose: false };

function optionNumber(options, key, fallback) {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function optionBoolean(options, key, fallback) {
  return typeof options[key] === 'boolean' ? options[key] : fallback;
}

function plainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every((block) => block?.type === 'text')) {
    return content.map((block) => block.text).join('');
  }
  return undefined;
}

export const register = (on, options) => {
  const isEnabled = optionBoolean(options, 'trimResults', DEFAULTS.isEnabled);
  if (!isEnabled) return;
  const tools = new Set(
    (typeof options.trimTools === 'string' && options.trimTools.length > 0 ? options.trimTools : DEFAULTS.tools)
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const thresholdChars = optionNumber(options, 'trimThresholdChars', DEFAULTS.thresholdChars);
  const trimOptions = {
    thresholdChars,
    headChars: Math.round(thresholdChars * 0.375),
    tailChars: Math.round(thresholdChars * 0.3),
  };
  const isVerbose = optionBoolean(options, 'trimVerbose', DEFAULTS.isVerbose);

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    try {
      const tool = e.origin?.kind === 'tool' ? e.origin.tool : undefined;
      if (!tool || !tools.has(tool)) return next(e);

      let isChanged = false;
      const content = [];
      for (let i = 0; i < e.message.content.length; i++) {
        const block = e.message.content[i];
        const text = block?.type === 'tool_result' ? plainText(block.content) : undefined;
        if (text === undefined || text.length <= thresholdChars) {
          content.push(block);
          continue;
        }
        const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'));
        const savedTo = home ? `${home.replace(/\\/g, '/').replace(/\/+$/, '')}/.claude/trimmed-results/${e.uuid}-${i}.txt` : undefined;
        const result = trimText(text, trimOptions, { isError: block.is_error === true, savedTo });
        if (!result.changed) {
          content.push(block);
          continue;
        }
        if (result.droppedLines > 0) {
          if (!savedTo) {
            content.push(block);
            continue;
          }
          await $.fs.write(savedTo, text);
        }
        content.push({
          ...block,
          content: typeof block.content === 'string' ? result.text : [{ type: 'text', text: result.text }],
        });
        isChanged = true;
        if (isVerbose) $.ui.log(`trimmed ${tool} result ${text.length} -> ${result.text.length} chars`);
      }
      return isChanged ? next({ ...e, message: { ...e.message, content } }) : next(e);
    } catch {
      return next(e);
    }
  });
};
