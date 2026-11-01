#!/usr/bin/env node
// Deletes the copies thinwood saved of trimmed and truncated text once they are old enough that
// nothing will ask for them: node scripts/prune-saved.mjs [days=14] [--dry-run]
// The plugin sandbox can write files but not delete them, so this runs outside it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FOLDERS = ['trimmed-results', 'thinwood-saved'];

export function pruneOlderThan(root, days, { dryRun = false, now = Date.now() } = {}) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = fs.statSync(full);
      if (stat.mtimeMs >= cutoff) continue;
      files++;
      bytes += stat.size;
      if (!dryRun) fs.unlinkSync(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return { files, bytes };
}

if (process.argv[1]?.endsWith('prune-saved.mjs')) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const days = Number(args.find((arg) => /^\d+(\.\d+)?$/.test(arg)) ?? 14);
  let files = 0;
  let bytes = 0;
  for (const folder of FOLDERS) {
    const found = pruneOlderThan(path.join(os.homedir(), '.claude', folder), days, { dryRun });
    files += found.files;
    bytes += found.bytes;
  }
  console.log(`${dryRun ? 'would delete' : 'deleted'} ${files} files (${(bytes / 1e6).toFixed(1)} MB) older than ${days} days`);
}
