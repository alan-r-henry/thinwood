// Drop-in replacement for fast-jev-compaction's Claude Code hook
// (hooks/fast-jev.ts) that scores with a local Ollama model instead of
// TypeSafe. NOT wired into Claude Code yet: doing so needs the early-access
// function-hooks flag and a CLI new enough to support it (see README.md).
//
// Once those are in place, this file plays the same role as the original
// repo's hooks/fast-jev.ts and is registered the same way.

import { compact, reductionRatio } from '../src/compact.mjs';
import { ollamaAsker } from '../src/ollama-asker.mjs';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: 'qwen2.5:14b-instruct',
  baseUrl: 'http://localhost:11434',
};

function optionNumber(options, key, fallback) {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options, key) {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function resolveHookConfig(options) {
  const numbers = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ]) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  return {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(options, 'minReductionRatio', HOOK_DEFAULTS.minReductionRatio),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    baseUrl: optionString(options, 'baseUrl') ?? HOOK_DEFAULTS.baseUrl,
    goal: optionString(options, 'goal'),
  };
}

// The plugin sandbox strips ambient globals (no bare `fetch`); network calls
// go through `$.http.fetch`, which returns { status, ok, text } with `text`
// already resolved to a string rather than fetch's async .text() method.
// This adapts that shape back to what ollama-asker.mjs (written to also run
// standalone against real fetch) expects.
function sandboxFetch($) {
  return async (url, init) => {
    const response = await $.http.fetch(url, init);
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.text,
      json: async () => JSON.parse(response.text),
    };
  };
}

async function compactSession(messages, config, $) {
  const asker = ollamaAsker({ baseUrl: config.baseUrl, model: config.model, fetch: sandboxFetch($) });
  const result = await compact(messages, asker, config);
  return { result, messages: result.messages };
}

function percent(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result) {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

function notify($, text) {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register = (on, options) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  let proactiveUnavailable = false;

  on('session.compact', async ($, event, next) => {
    try {
      const { result, messages } = await compactSession(event.messages, configured, $);
      if (reductionRatio(result) < configured.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(configured.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        `local-jev: kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      notify($, `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`);
      return next(event);
    }
  });

  on('turn.complete', async ($, event, next) => {
    if (compacting || proactiveUnavailable) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Headless (-p / SDK, which includes the Desktop Code tab) can't compact from a hook;
      // the engine's own auto-compact and /compact still reach the session.compact hook above.
      if (/headless/i.test(message)) proactiveUnavailable = true;
      else $.ui.log(`auto-compact skipped (${message})`);
    } finally {
      compacting = false;
    }
    return next(event);
  });
};
