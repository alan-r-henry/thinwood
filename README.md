# local-jev-compaction

A free, fully local stand-in for [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)'s
TypeSafe/Jev API call. Same idea — never summarize a transcript, only delete
tool calls and results a model says are no longer needed — but the scoring
model is a local Ollama model instead of a paid third-party API, so nothing
leaves your machine and there is no per-request cost.

**Status: working, confirmed end-to-end on live Claude Code** (2.1.280,
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, manual `/compact`). Installed
persistently (user scope) from `C:\Users\csp\claude-plugins\local-jev-compaction`,
with the flag set by default in `~/.claude/settings.json`. `compactAtPercent`
is configured to `80` (see `pluginConfigs` in that file).

## What's here

- `src/state.mjs`, `src/compact.mjs` — the compaction algorithm (batching,
  fitting the state into a token budget, applying keep/drop decisions),
  ported to plain JS from fast-jev-compaction's MIT-licensed `src/`. No
  TypeSafe-specific code.
- `src/ollama-asker.mjs` — the replacement for `JevClient`. Implements the
  same `{ ask(state, questions) }` contract the library expects, but sends
  the state and questions to a local Ollama model and constrains its output
  to valid JSON via Ollama's structured-output `format` (a JSON schema), so
  it reliably returns a probability per question instead of prose. Accepts
  a `fetch` override so it can run both standalone (real `fetch`) and inside
  the Claude Code plugin sandbox (no bare `fetch`; see below).
- `.claude-plugin/plugin.json` — the plugin manifest (`userConfig` for
  `baseUrl`, `model`, thresholds, etc).
- `hooks/hooks.json` — declares which file is the function-hooks module
  (`{"modules": ["./local-jev.ts"]}`). **Required** — Claude Code does not
  auto-discover `hooks/*.ts` by convention; without this file the plugin
  loads (shows up in plugin listings) but its hook never registers, silently,
  no error.
- `hooks/local-jev.ts` — the Claude Code plugin hook (`hooks/fast-jev.ts` in
  the original repo), adapted to call `ollama-asker.mjs` instead of
  `api.typesafe.ai`, through a `sandboxFetch($)` adapter (see below).

## Requirements

- [Ollama](https://ollama.com) running locally.
- The `qwen2.5:14b-instruct` model pulled (`ollama pull qwen2.5:14b-instruct`,
  ~9GB). Any instruction-tuned model Ollama can run works — change
  `DEFAULT_MODEL` in `src/ollama-asker.mjs`, or the plugin's `model` option.
- Claude Code 2.1.274+ (2.1.280 tested) with function hooks enabled for the
  session — see below.

## Using the library directly

```js
import { compact, reductionRatio } from './src/compact.mjs';
import { ollamaAsker } from './src/ollama-asker.mjs';

const result = await compact(transcript, ollamaAsker(), { preserveRecentMessages: 6 });
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`transcript` is an array of `{ role, text, toolUses, toolResults }` messages
— the same shape fast-jev-compaction expects (a subset of Claude Code's
session message format).

## Wiring into Claude Code

Function hooks are still early-access (no committed GA date as of writing —
see [anthropics/claude-code#91870](https://github.com/anthropics/claude-code/issues/91870)),
gated behind `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Two ways to load this
plugin with that flag set:

```sh
# Transient, this invocation only — no permanent install:
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /path/to/local-jev-compaction

# Or install it for real (persists across sessions):
claude plugin marketplace add /path/to/local-jev-compaction
claude plugin install local-jev-compaction@local-jev-compaction
# then always launch with: CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

The flag itself isn't persisted anywhere by this project — set it as an env
var per launch, or put it in `~/.claude/settings.json`'s `env` block if you
want it on by default (not done automatically; that's a global change worth
doing deliberately).

### Two real bugs found getting this working (both already fixed here)

1. **Missing `hooks/hooks.json`.** Claude Code does not scan `hooks/*.ts` by
   convention. Without a `hooks.json` naming the module file, the plugin
   directory is recognized (shows up in debug logs, skills checks run) but
   the hook itself is never loaded — no error, it just silently never fires.
   Confirmed by diffing debug logs (`--debug-file`) between this plugin and
   the unmodified upstream repo, which does ship this file.
2. **No bare `fetch` in the plugin sandbox.** The function-hooks runtime
   sandboxes each plugin (a worker + `node:vm`), stripping ambient globals;
   `ollama-asker.mjs`'s default `fetch` reference threw `fetch is not
   defined` at runtime. Fixed with `sandboxFetch($)` in `hooks/local-jev.ts`,
   which adapts `$.http.fetch`'s `{ status, ok, text }` shape (text already
   a resolved string, not an async method) back to the `Response`-like
   interface `ollama-asker.mjs` expects.

### What's been verified live

Tested against real Claude Code sessions with real tool-call history and a
manual `/compact`:

- The plugin loads and its `session.compact` / `turn.complete` hooks
  register (`hooks module local-jev-compaction@inline loaded ... tier user`).
- `session.compact` fires on manual `/compact` and calls the local model
  through `$.http.fetch` (`POST http://localhost:11434/api/chat`, real 200
  response, ~20s for one request on `qwen2.5:14b-instruct`).
- The model returns valid scored decisions and at least one real
  `call_dropped` was observed (a deliberately redundant duplicate file read).
- The `minReductionRatio` safety floor correctly falls back to Claude's
  built-in summary when the local model doesn't find enough to prune —
  confirmed this is the *floor* working as designed, not a failure: short,
  legitimately-useful-throughout sessions should keep everything.

Not yet observed live: the success path where reduction clears the 25%
floor and the plugin's pruned history actually replaces the built-in
summary (`local-jev: kept N/M messages, no summary (...)`). That just needs
a real session with enough genuinely superseded tool output (e.g. a stale
file read followed by an edit and a passing test that makes it moot).

## Accuracy notes

- Quality depends entirely on the local model's judgment. `qwen2.5:14b` is a
  reasonable default; a smaller model will be faster but may make worse
  keep/drop calls, a larger one the opposite.
- Ollama's `format` (JSON schema) constrains the *shape* of the output, not
  its correctness — the model can still confidently give a bad probability.
  `ollama-asker.mjs` throws if a value is missing or out of `[0, 1]`, which
  causes the whole compaction to fail closed and fall back rather than
  silently drop something on malformed output.
- Every request resends the full state (as the original does), so a long
  history costs one local inference pass per handful of tool calls — slower
  than the hosted API, but still free and private.

## Credits and licence

This is adapted from [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT). Much of `src/compact.mjs`, `src/state.mjs` and `hooks/local-jev.ts`
follows that project's code, reworked to ask a local Ollama model instead of
the hosted Jev API. Released under the MIT licence; see [LICENSE](LICENSE),
which keeps the original authors' notice.
