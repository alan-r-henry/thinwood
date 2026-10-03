# thinwood

A Claude Code plugin that keeps long sessions cheap without sending anything off your machine. It does two things:

1. **Compaction by pruning, not summarizing.** When the context gets large, a local Ollama model scores every old tool call and result and only the ones that no longer matter are dropped or truncated. Everything kept stays verbatim. It is a port of [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT) with the paid TypeSafe/Jev API replaced by a local model.
2. **Tool-result trimming.** Large Bash/PowerShell/Grep outputs are shrunk before the session keeps them (noise stripped, repeats folded, the middle cut while keeping head, tail and error lines). The full original is saved to disk and its path is left in the result, so nothing is lost.

## Requirements

- Claude Code **2.1.286 or newer** with function hooks enabled (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, e.g. in the `env` block of `~/.claude/settings.json`). Older engines do not know the `session.append` event used by the trimmer and **refuse to load the whole plugin**.
- [Ollama](https://ollama.com) running locally with `qwen2.5:14b-instruct` pulled (`ollama pull qwen2.5:14b-instruct`, ~9GB). Any instruction-tuned model works; set the `model` option.
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
| `minReductionRatio` | 0.25 | If pruning would free less than this fraction, fall back to Claude Code's built-in summary. |
| `keepThreshold` | 0.5 | Minimum probability that a tool call or result is still needed. |
| `preserveRecentMessages` | 6 | Newest messages that are never touched. |
| `model`, `baseUrl` | `qwen2.5:14b-instruct`, `http://localhost:11434` | Ollama model and server. |
| `maxStateTokens`, `maxRequestTokens`, `truncateHeadChars` | 25000, 30000, 300 | Request sizing and how much of a dropped result is kept. |
| `trimResults` | true | Turn the trimmer on or off. |
| `trimTools` | `Bash,PowerShell,Grep` | Tools whose results may be trimmed. |
| `trimThresholdChars` | 4000 | Results longer than this are trimmed (errors get three times the allowance). |
| `trimVerbose` | false | Log a line each time a result is trimmed. |

## How the compaction trigger works

After every turn the hook reads the context size. Past a threshold it logs one line and asks for a compaction:

- In the terminal it calls `$.session.compact()` directly.
- In **headless sessions** (`-p`, the SDK, and the Claude Desktop Code tab) that call is refused by the engine. The hook remembers that and queues `/compact` for just after the turn instead. Either way the compaction goes through the `session.compact` hook, so the local scoring runs.
- A three-turn cooldown stops a window that cannot get below the threshold from compacting every turn.

If Ollama is unreachable, returns bad output, or finds too little to prune, the hook hands control back and the built-in summary runs, so a failure never breaks a session.

## How the trimmer works

A `session.append` hook on tool results rewrites a result before it is stored, so the model and the transcript only ever hold the trimmed form (prompt caching is unaffected). For a result over the threshold it:

1. strips ANSI codes and carriage-return progress, and folds runs of identical lines;
2. keeps the head and tail, plus up to 25 error/warning lines from the cut middle;
3. saves the exact original to `~/.claude/trimmed-results/<row id>-<n>.txt` and points to it in the result.

It never trims a result it could not save, never touches images or mixed blocks, and leaves `Read` and `WebFetch` alone by default because exact text matters there (add them to `trimTools` at your own risk). Saved originals are not cleaned up automatically; delete the folder whenever you like.

Measured on 2 months of real history, restricted to the default tools, a 4000-character threshold would have trimmed about 4% of results and cut roughly 4% of all context growth. That is modest; the bigger saving comes from compacting earlier (`compactAtTokens`).

## Layout

- `hooks/hooks.json` names the single hooks module (the engine allows exactly one per plugin); `hooks/register.ts` registers both features.
- `hooks/compaction.ts` compaction hook and trigger; `hooks/trim-results.ts` trimmer hook.
- `src/compact.mjs`, `src/state.mjs` compaction algorithm (ported from fast-jev-compaction); `src/ollama-asker.mjs` local scorer; `src/trim.mjs` pure trimming helpers.
- `test/trim.test.mjs` unit tests: `node --test`.

## Notes from building it

- The plugin sandbox has no bare `fetch`; network calls go through `$.http.fetch`, adapted in `sandboxFetch($)`.
- `hooks.json` is required, and it takes one module only: more than one makes the whole plugin fail to load.
- Pruning quality depends on the local model; Ollama's JSON-schema output fixes the shape of answers, not their correctness, and a malformed answer aborts the compaction and falls back.
