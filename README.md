# thinwood

A Claude Code plugin that keeps long sessions cheap without sending anything off your machine. It does two things:

1. **Compaction by pruning, not summarizing.** When the context gets large, old tool results the assistant has stopped using, and the bodies of old Write/Edit calls, are truncated, and everything else stays verbatim. The full text of everything cut is saved to disk and named in the marker. Results are ranked by how the assistant actually used them (no model, no network, milliseconds); an Ollama model can score them instead (`scoring: model`). It is a port of [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT) with the paid TypeSafe/Jev API replaced by a local model.
2. **Tool-result trimming.** Large Bash/PowerShell/Grep outputs are shrunk before the session keeps them (noise stripped, repeats folded, the middle cut while keeping head, tail and error lines). The full original is saved to disk and its path is left in the result, so nothing is lost.

## Requirements

- Claude Code **2.1.286 or newer** with function hooks enabled (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, e.g. in the `env` block of `~/.claude/settings.json`). Older engines do not know the `session.append` event used by the trimmer and **refuse to load the whole plugin**.
- Optional, only for `scoring: model`: [Ollama](https://ollama.com) running locally with `qwen2.5:14b-instruct` pulled (`ollama pull qwen2.5:14b-instruct`, ~9GB). Any instruction-tuned model works; set the `model` option.
- Node.js 18+ only for the unit tests (`node --test`); the hooks run inside Claude Code.

## Install

```sh
claude plugin marketplace add /path/to/this/folder
claude plugin install thinwood@thinwood
```

Function hooks are early access and the engine gates them behind a server-side rollout flag. After a Claude Code upgrade the first process can see the flag as off until it refreshes; start another session and it loads.

## Options

Set them with `claude plugin install <plugin> --config key=value` or `/plugin configure`; they land under `pluginConfigs` in `~/.claude/settings.json`.

| Option | Default | What it does |
| --- | --- | --- |
| `compactAtTokens` | 300000 | Request compaction once the context reaches this many tokens (0 disables). |
| `compactAtPercent` | 60 | Also compact at this percent of the model's window; whichever threshold hits first wins. |
| `scoring` | `reuse` | `reuse` ranks old results by how the assistant used them (see below). `model` asks the local Ollama model about every call: slow, and a 14B model gave nearly every call the same score. |
| `dropFraction` | 0.5 | With `reuse`: the share of old result text to truncate. Higher frees more but drops results that were still wanted. |
| `inputDropFraction`, `minInputChars` | 0.7, 1500 | Old tool calls' long input fields (a Write's body, an Edit's text, a long command) at least `minInputChars` long are truncated, Write/Edit first and oldest first, until this share is gone. 0 keeps every input. |
| `protectRecentMessages` | 24 | With `reuse`: results in this many of the latest messages are never truncated, however much has to go. |
| `saveDropped` | true | Save the full text of every truncated result and input under `~/.claude/thinwood-saved/` and name the file in the marker. Off, the marker says to re-run the tool. |
| `pruneBeforeSummary` | true | When too little can be cut to skip the summary, still give the built-in summary the pruned history so it has less to read. |
| `minReductionRatio` | 0.25 | Pruning must free at least this fraction, or the built-in summary runs. With `reuse` the hook first drops more, as little more as reaches it, before giving up. |
| `keepThreshold` | 0.5 | Minimum probability that a tool call or result is still needed. |
| `preserveRecentMessages` | 6 | Newest messages that are never touched. |
| `model`, `baseUrl` | `qwen2.5:14b-instruct`, `http://localhost:11434` | Ollama model and server. |
| `maxStateTokens`, `maxRequestTokens`, `truncateHeadChars` | 8000, 12000, 300 | Request sizing and how much of a dropped result is kept. Sized so one request to a 14B model finishes inside the plugin sandbox's 30 s limit; Ollama's context window is set to fit (16K). |
| `maxCallsPerRequest`, `minResultChars` | 20, 500 | Tool calls scored per request (two questions each), and the smallest result worth scoring; shorter results are kept without asking. |
| `minScoreSpread` | 0.15 | If the first request's scores differ by less than this the model cannot tell what to drop, and the built-in summary runs right away instead of after minutes of scoring. |
| `trimResults` | true | Turn the trimmer on or off. |
| `trimTools` | `Bash,PowerShell,Grep` | Tools whose results may be trimmed. |
| `trimThresholdChars` | 4000 | Results longer than this are trimmed (errors get three times the allowance). |
| `trimVerbose` | false | Log a line each time a result is trimmed. |

## How the compaction trigger works

After every turn the hook reads the context size. Past a threshold it logs one line and asks for a compaction:

- In the terminal it calls `$.session.compact()` directly.
- In **headless sessions** (`-p`, the SDK, and the Claude Desktop Code tab) that call is refused by the engine. The hook remembers that and queues `/compact` for just after the turn instead. Either way the compaction goes through the `session.compact` hook, so the local scoring runs.
- A three-turn cooldown stops a window that cannot get below the threshold from compacting every turn.

If pruning would free too little even after dropping more (or, with `scoring: model`, Ollama is unreachable or returns bad output), the hook hands control back and the built-in summary runs, so a failure never breaks a session. A compaction that would leave a tool call without its result, or an event with no messages, is refused the same way.

### Is it working?

Every compaction decision (trigger, compacted, fallback and why) is appended to `~/.claude/thinwood-log.jsonl`, newest last, 300 lines kept. Read it with:

```sh
node scripts/status.mjs
```

which prints the totals, the reasons for any fallbacks, the last ten events, and the size of the folders thinwood saves into. To see what it would free on your own saved sessions, with any settings, without changing anything:

```sh
node scripts/measure.mjs --min 300 --opts '{"dropFraction":0.6}'
```

The plugin sandbox can write files but not delete them, so old saved copies are removed outside it: `node scripts/prune-saved.mjs 14` deletes those older than 14 days (`--dry-run` shows what would go).

### How results are scored

A result counts as *used* in a later assistant message when that message (its text, or the input of a different tool call) repeats at least two distinctive tokens from it: a path, an identifier, an error string. Tokens that appear in many results are ignored. Results are ranked by `sqrt(size) x sqrt(messages since last use) / (1 + times used)`, times 4 if the same call was made again later, times 0.3 for errors. The top of the ranking is truncated until `dropFraction` of the eligible text is gone; the call stays in the history with the first 300 characters and a marker naming the saved copy. Long inputs of old calls are cut the same way (Write and Edit bodies first, since the file on disk has them). If that frees less than `minReductionRatio`, the hook searches for the smallest larger share that does. The last six messages, the first message, results in the latest 24 messages, results under 500 characters, and results with too few distinctive tokens to judge are never touched.

On the author's 18 real sessions of 350 to 19,000 messages the plain 50% cut freed 10-24% of all text, because a fifth to a half of every session is tool *inputs*, which only the input cut reaches. With it, all 18 reach the 25% minimum, cutting 50-64% of old results, and the slowest (19,000 messages, 13 MB) takes about half a second.

Tested offline on seven of the author's own sessions (about 2,600 old results in six of them, plus one 19,000-message session held out): freeing half of all old result text lost about 8% of the results the assistant went on to reuse in the next 80 messages (random choice lost 50%, ranking by age alone 40%, by size alone 9% of results but 34% of their text). Freeing 70% lost about 25%. "Reused" is measured by token overlap, a proxy for needing a result, not proof; the assistant can re-run whatever is dropped.

### Using the Ollama model instead

**Keep the model files on a fast disk.** A request that takes longer than 30 s is aborted, and an aborted model load is cancelled, not finished in the background. A 14B model loaded from a USB hard disk took ~100 s (about 12 s from an NVMe SSD), so every compaction fell back. The hook loads the model in a request of its own just before scoring, and again once the context passes 75% of a trigger, so the model is already in memory when it is needed. Requests go one at a time, because Ollama answers them one at a time and a queued request would spend its 30 s waiting.

## How the trimmer works

A `session.append` hook on tool results rewrites a result before it is stored, so the model and the transcript only ever hold the trimmed form (prompt caching is unaffected). For a result over the threshold it:

1. strips ANSI codes and carriage-return progress, and folds runs of identical lines;
2. clips any single line over 1200 characters (minified JSON, base64) to its first 800;
3. keeps the head and tail, plus up to 25 error/warning lines from the cut middle;
4. saves the exact original to `~/.claude/trimmed-results/<row id>-<n>.txt` and points to it in the result. A later compaction that truncates the result keeps that pointer.

It never trims a result it could not save, never touches images or mixed blocks, and leaves `Read` and `WebFetch` alone by default because exact text matters there (add them to `trimTools` at your own risk). Saved originals are not cleaned up automatically; see `scripts/prune-saved.mjs`.

Measured on 2 months of real history, restricted to the default tools, a 4000-character threshold would have trimmed about 4% of results and cut roughly 4% of all context growth. That is modest; the bigger saving comes from compacting earlier (`compactAtTokens`).

## Layout

- `hooks/hooks.json` names the single hooks module (the engine allows exactly one per plugin); `hooks/register.ts` registers both features.
- `hooks/compaction.ts` compaction hook and trigger; `hooks/trim-results.ts` trimmer hook.
- `src/compact.mjs`, `src/state.mjs` compaction algorithm (ported from fast-jev-compaction); `src/reuse.mjs` scoring by how results were used; `src/inputs.mjs` cutting old tool inputs; `src/ollama-asker.mjs` optional local-model scorer; `src/trim.mjs` pure trimming helpers.
- `scripts/status.mjs`, `scripts/measure.mjs`, `scripts/prune-saved.mjs` look at it, tune it and clean up after it.
- `test/` unit tests, including the hook run against a stub of the plugin sandbox: `npm test`.

## Notes from building it

- The plugin sandbox has no bare `fetch`; network calls go through `$.http.fetch`, adapted in `sandboxFetch($)`.
- `hooks.json` is required, and it takes one module only: more than one makes the whole plugin fail to load.
- Tried and rejected: weighting results by tool (cut file reads and searches sooner, shell output later, on the idea that they can be re-run). On real sessions it lost more of what was reused later (9-12% against 6% when freeing half), so it is not in. Long tool inputs are reused later 83-87% of the time, so reuse cannot rank them; they go by whether the file on disk still has them.
- With `scoring: model`, quality depends on the local model; Ollama's JSON-schema output fixes the shape of answers, not their correctness, and a malformed answer aborts the compaction and falls back. In testing the 14B model scored nearly every call the same, which is why `reuse` is the default.
