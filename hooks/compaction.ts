// Compaction hook: scores tool calls with a local Ollama model instead of
// summarizing (a port of fast-jev-compaction's hooks/fast-jev.ts), and asks
// for a compaction once the context passes a token or percent threshold.

import { DEFAULT_OPTIONS, compact, reductionRatio } from '../src/compact.mjs';
import { ollamaAsker } from '../src/ollama-asker.mjs';

const COOLDOWN_TURNS = 3;
// start loading the model once the context is this close to a compaction trigger, and again
// after this long, so the model is loaded (the load can take longer than a request may wait)
const PREWARM_AT = 0.75;
const PREWARM_EVERY_MS = 10 * 60 * 1000;

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  compactAtTokens: 300000,
  minReductionRatio: 0.25,
  model: 'qwen2.5:14b-instruct',
  baseUrl: 'http://localhost:11434',
};

function optionNumber(options, key, fallback) {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionBoolean(options, key, fallback) {
  return typeof options[key] === 'boolean' ? options[key] : fallback;
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
    'maxCallsPerRequest',
    'minResultChars',
    'minScoreSpread',
    'numCtx',
    'dropFraction',
    'minInputChars',
    'inputDropFraction',
    'protectRecentMessages',
  ]) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  return {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    compactAtTokens: optionNumber(options, 'compactAtTokens', HOOK_DEFAULTS.compactAtTokens),
    minReductionRatio: optionNumber(options, 'minReductionRatio', HOOK_DEFAULTS.minReductionRatio),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    baseUrl: optionString(options, 'baseUrl') ?? HOOK_DEFAULTS.baseUrl,
    goal: optionString(options, 'goal'),
    scoring: optionString(options, 'scoring') === 'model' ? 'model' : 'reuse',
    saveDropped: optionBoolean(options, 'saveDropped', true),
    pruneBeforeSummary: optionBoolean(options, 'pruneBeforeSummary', true),
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

// Ollama's own window defaults to 4096 tokens and cuts longer prompts from the front, so give
// it room for a full request plus its short answer, in the 2048-token steps it allocates.
function contextWindow(config) {
  if (typeof config.numCtx === 'number') return config.numCtx;
  const request = config.maxRequestTokens ?? DEFAULT_OPTIONS.maxRequestTokens;
  return Math.ceil((request + 2500) / 2048) * 2048;
}

function makeAsker(config, $) {
  return ollamaAsker({
    baseUrl: config.baseUrl,
    model: config.model,
    numCtx: contextWindow(config),
    fetch: sandboxFetch($),
  });
}

async function claudeDirectory($) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'));
  return home ? `${home.replace(/\\/g, '/').replace(/\/+$/, '')}/.claude` : undefined;
}

// The full text of what a compaction cuts is saved here, and each marker names its file.
async function savedDirectory($) {
  const claude = await claudeDirectory($);
  return claude ? `${claude}/thinwood-saved` : undefined;
}

// One JSON line per compaction decision, newest last, so "is it working?" has an answer
// (read it with scripts/status.mjs). The sandbox cannot append, so the file is rewritten whole
// and kept short.
const LOG_KEEP = 300;

async function record($, entry) {
  try {
    const claude = await claudeDirectory($);
    if (!claude) return;
    const path = `${claude}/thinwood-log.jsonl`;
    const lines = (await $.fs.exists(path)) ? (await $.fs.read(path)).split('\n').filter(Boolean) : [];
    lines.push(JSON.stringify({ at: new Date().toISOString(), ...entry }));
    await $.fs.write(path, `${lines.slice(-LOG_KEEP).join('\n')}\n`);
  } catch {
    // the log is a convenience; never let it break a compaction
  }
}

function figures(result) {
  const { stats } = result;
  return {
    messagesBefore: stats.messagesBefore,
    messagesAfter: stats.messagesAfter,
    charsBefore: stats.charsBefore,
    charsAfter: stats.charsAfter,
    resultsCut: stats.resultsDropped,
    inputsCut: stats.inputsTruncated,
    escalations: stats.escalations ?? 0,
    ms: stats.ms,
  };
}

async function writeSaved($, saved) {
  try {
    for (let i = 0; i < saved.length; i += 16) {
      await Promise.all(saved.slice(i, i + 16).map((file) => $.fs.write(file.path, file.text)));
    }
    return true;
  } catch (error) {
    $.ui.log(`thinwood: could not save what was cut (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
}

async function compactSession(messages, config, $, directory) {
  const pathFor = directory
    ? (kind, id) => `${directory}/${id}-${kind}.${kind === 'input' ? 'json' : 'txt'}`
    : undefined;
  if (config.scoring !== 'model') {
    // scored from how the assistant used each result: no model, no network. Drop more, in steps,
    // until the minimum reduction is met, so the built-in summary is a last resort.
    const result = await compact(messages, null, {
      ...config,
      targetReduction: config.minReductionRatio,
      pathFor,
    });
    return { result, messages: result.messages };
  }
  const asker = makeAsker(config, $);
  // load the model in a request of its own: a cold load plus the first scoring request would
  // not fit the sandbox's 30 s limit together
  await asker.warm();
  const result = await compact(messages, asker, { ...config, pathFor });
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
    stats.inputsTruncated > 0 ? `${stats.inputsTruncated} inputs truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  // about four characters to a token
  const freedTokens = Math.max(0, Math.round((stats.charsBefore - stats.charsAfter) / 4000));
  return `${percent(reductionRatio(result))} reduction (~${freedTokens}k tokens); ${
    parts.join(', ') || 'no tool calls'
  }; ${
    stats.stateStage === 'reuse'
      ? 'scored by how each result was used'
      : `state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`
  }`;
}

function notify($, text) {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register = (on, options) => {
  const configured = resolveHookConfig(options);
  let isCompacting = false;
  let isHeadless = false;
  let cooldownTurns = 0;
  let lastPrewarm = 0;

  on('session.compact', async ($, event, next) => {
    try {
      if (!Array.isArray(event.messages) || event.messages.length === 0) return next(event);
      const directory = configured.saveDropped ? await savedDirectory($) : undefined;
      let attempt = await compactSession(event.messages, configured, $, directory);
      if (
        reductionRatio(attempt.result) >= configured.minReductionRatio &&
        attempt.result.saved.length > 0 &&
        !(await writeSaved($, attempt.result.saved))
      ) {
        // markers must not name files that were never written
        attempt = await compactSession(event.messages, configured, $, undefined);
      }
      const { result, messages } = attempt;
      if (reductionRatio(result) < configured.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(configured.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        await record($, { event: 'fallback', reason: 'below minimum', ...figures(result) });
        // the summary has less to read when what could be cut already is cut
        if (configured.pruneBeforeSummary && reductionRatio(result) > 0) {
          let pruned = messages;
          if (attempt.result.saved.length > 0 && !(await writeSaved($, attempt.result.saved))) {
            pruned = (await compactSession(event.messages, configured, $, undefined)).messages;
          }
          return next({ ...event, messages: pruned });
        }
        return next(event);
      }
      notify(
        $,
        `thinwood: kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      await record($, { event: 'compacted', ...figures(result) });
      return { messages };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notify($, `fallback to built-in summary (${reason})`);
      await record($, { event: 'fallback', reason });
      return next(event);
    }
  });

  on('turn.complete', async ($, event, next) => {
    if (cooldownTurns > 0) {
      cooldownTurns--;
      return next(event);
    }
    if (isCompacting) return next(event);
    try {
      const { context } = await $.session.usage();
      const tokens = context.tokens ?? 0;
      const isOverPercent = (context.percent ?? 0) >= configured.compactAtPercent;
      const isOverTokens = configured.compactAtTokens > 0 && tokens >= configured.compactAtTokens;
      if (!isOverPercent && !isOverTokens) {
        const isNear =
          configured.scoring === 'model' &&
          ((context.percent ?? 0) >= configured.compactAtPercent * PREWARM_AT ||
            (configured.compactAtTokens > 0 && tokens >= configured.compactAtTokens * PREWARM_AT));
        if (isNear && Date.now() - lastPrewarm > PREWARM_EVERY_MS) {
          lastPrewarm = Date.now();
          // off the turn's path; a failure here only means the compaction warms the model itself
          $.clock.after(100, async () => {
            try {
              await makeAsker(configured, $).warm();
            } catch (error) {
              $.ui.log(`thinwood: model warm-up skipped (${error instanceof Error ? error.message : String(error)})`);
            }
          });
        }
        return next(event);
      }
      isCompacting = true;
      cooldownTurns = COOLDOWN_TURNS;
      $.ui.log(`context at ${Math.round(tokens / 1000)}k tokens: compacting`);
      await record($, { event: 'trigger', tokens, percent: context.percent ?? 0 });
      if (!isHeadless) {
        try {
          await $.session.compact();
          return next(event);
        } catch (error) {
          if (!/headless/i.test(error instanceof Error ? error.message : String(error))) throw error;
          isHeadless = true;
        }
      }
      // Headless sessions (-p / SDK, including the Desktop Code tab) can't compact from inside
      // a hook. Queue /compact for after the turn; it reaches the session.compact hook above.
      $.clock.after(1500, async () => {
        try {
          await $.command.run({ command: 'compact' });
        } catch (error) {
          $.ui.log(`auto-compact skipped (${error instanceof Error ? error.message : String(error)})`);
        }
      });
    } catch (error) {
      $.ui.log(`auto-compact skipped (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      isCompacting = false;
    }
    return next(event);
  });
};
