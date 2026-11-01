#!/usr/bin/env node
// Is thinwood working? Reads the log the compaction hook keeps and the folders it saves into:
//   node scripts/status.mjs [--last 10]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function summarizeLog(entries) {
  const compacted = entries.filter((entry) => entry.event === 'compacted');
  const fallbacks = entries.filter((entry) => entry.event === 'fallback');
  const freedChars = compacted.reduce((sum, entry) => sum + (entry.charsBefore - entry.charsAfter), 0);
  const reasons = new Map();
  for (const entry of fallbacks) reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
  return {
    triggers: entries.filter((entry) => entry.event === 'trigger').length,
    compacted: compacted.length,
    fallbacks: fallbacks.length,
    freedTokens: Math.round(freedChars / 4),
    reasons: [...reasons].sort((a, b) => b[1] - a[1]),
    lastCompacted: compacted.at(-1)?.at,
    lastFallback: fallbacks.at(-1),
  };
}

function folderSize(dir) {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(dir)) return { files, bytes };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = folderSize(full);
      files += inner.files;
      bytes += inner.bytes;
    } else {
      files++;
      bytes += fs.statSync(full).size;
    }
  }
  return { files, bytes };
}

function thousands(tokens) {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function describe(entry) {
  const when = entry.at?.replace('T', ' ').slice(0, 19) ?? '?';
  if (entry.event === 'compacted') {
    const freed = Math.round(((entry.charsBefore - entry.charsAfter) / entry.charsBefore) * 100);
    return `${when}  compacted  freed ${freed}% (~${Math.round((entry.charsBefore - entry.charsAfter) / 4000)}k tokens), ${entry.resultsCut} results and ${entry.inputsCut} inputs cut, ${entry.ms} ms`;
  }
  if (entry.event === 'fallback') return `${when}  fallback   ${entry.reason}`;
  if (entry.event === 'trigger') return `${when}  trigger    context at ${Math.round(entry.tokens / 1000)}k tokens (${entry.percent}%)`;
  return `${when}  ${entry.event}`;
}

function main() {
  const claude = path.join(os.homedir(), '.claude');
  const lastIndex = process.argv.indexOf('--last');
  const last = lastIndex === -1 ? 10 : Number(process.argv[lastIndex + 1]);
  const entries = readLog(path.join(claude, 'thinwood-log.jsonl'));
  if (entries.length === 0) {
    console.log('No compactions logged yet: none has run since the log was added.');
  } else {
    const summary = summarizeLog(entries);
    console.log(`${summary.triggers} auto triggers, ${summary.compacted} compactions that skipped the summary (~${thousands(summary.freedTokens)} tokens freed), ${summary.fallbacks} fallbacks to the built-in summary`);
    for (const [reason, count] of summary.reasons) console.log(`  fallback x${count}: ${reason}`);
    console.log('');
    for (const entry of entries.slice(-last)) console.log(describe(entry));
  }
  for (const folder of ['trimmed-results', 'thinwood-saved']) {
    const { files, bytes } = folderSize(path.join(claude, folder));
    console.log(`\n${folder}: ${files} files, ${(bytes / 1e6).toFixed(1)} MB`);
  }
}

if (process.argv[1]?.endsWith('status.mjs')) main();
