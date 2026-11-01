# Changelog

## 0.2.0

Compaction now succeeds on real sessions: before, none of 18 sessions reached the 25% minimum and every compaction fell back to the built-in summary; now all 18 do.

- Old tool inputs (Write/Edit bodies, long commands) are truncated too; they were 18-54% of session text. Write/Edit first, since the file on disk has them.
- If a first pass frees too little, search for the smallest larger cut that reaches the target instead of giving up or cutting everything.
- Everything a compaction cuts is saved to `~/.claude/thinwood-saved/` and named in the marker; a trimmer pointer survives a later cut.
- When the summary still has to run, it gets the pruned history so it has less to read (`pruneBeforeSummary`).
- Results in the latest 24 messages are never cut (`protectRecentMessages`).
- The scorer uses an inverted index: a 19,000-message session went from 6.9 s to about 0.5 s.
- Trimmer: a single huge line (minified JSON, base64) used to be replaced by a 37-character marker with nothing kept; long lines are now clipped to their start and the original saved.
- Every compaction decision is logged to `~/.claude/thinwood-log.jsonl`; `scripts/status.mjs` reads it.
- `scripts/measure.mjs` replays your sessions to tune settings; `scripts/prune-saved.mjs` deletes old saved copies.
- Safety: a compaction that would leave a tool call or result unpaired is refused; messages with no text or tool lists no longer break it; the input messages are never mutated (tested on random sessions).
- The notification shows the tokens freed.
- 49 tests (was 10), including the hook against a stub sandbox, the Ollama path and the state fitting. They caught one bug on the way (each result was saved twice, the second time empty).

## 0.1.0

Rename from local-jev-compaction; reuse-based scoring; Ollama request sizing and warm-up; tool-result trimmer.
