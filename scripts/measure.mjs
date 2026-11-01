#!/usr/bin/env node
// Replays your saved Claude Code sessions through thinwood's compaction and reports how much
// each would free, so settings can be tuned on real data. Nothing is changed or sent anywhere.
//
//   node scripts/measure.mjs [--min 300] [--dir ~/.claude/projects] [--opts '{"dropFraction":0.6}']
//
// --min   only sessions with at least this many messages
// --opts  JSON of compaction options (see README); targetReduction defaults to 0.25

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { compact, messageChars, reductionRatio } from '../src/compact.mjs';

const MAX_FILE_BYTES = 300e6;

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((block) => block.text ?? '').join('') : '';

export async function readSession(file) {
  const messages = [];
  if (fs.statSync(file).size > MAX_FILE_BYTES) return messages;
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.startsWith('{')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry.message || (entry.type !== 'user' && entry.type !== 'assistant') || entry.isSidechain) continue;
    const content = entry.message.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    const message = { role: entry.message.role, text: '', toolUses: [], toolResults: [] };
    for (const block of blocks) {
      if (block.type === 'text') message.text += block.text;
      else if (block.type === 'tool_use') message.toolUses.push({ tool_use_id: block.id, tool: block.name, input: block.input ?? {} });
      else if (block.type === 'tool_result') {
        message.toolResults.push({ tool_use_id: block.tool_use_id, text: textOf(block.content), isError: block.is_error === true });
      }
    }
    messages.push(message);
  }
  return messages;
}

function share(part, whole) {
  return `${Math.round((100 * part) / whole)}%`;
}

function makeup(messages) {
  const sums = { assistant: 0, user: 0, inputs: 0, results: 0 };
  for (const message of messages) {
    sums[message.role === 'assistant' ? 'assistant' : 'user'] += message.text.length;
    for (const use of message.toolUses) sums.inputs += JSON.stringify(use.input).length;
    for (const result of message.toolResults) sums.results += result.text.length;
  }
  return sums;
}

async function main() {
  const root = argument('dir', path.join(os.homedir(), '.claude', 'projects'));
  const minMessages = Number(argument('min', 300));
  const options = { targetReduction: 0.25, ...JSON.parse(argument('opts', '{}')) };
  const files = [];
  for (const folder of fs.readdirSync(root)) {
    const dir = path.join(root, folder);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) if (name.endsWith('.jsonl')) files.push(path.join(dir, name));
  }

  let sessions = 0;
  let sum = 0;
  let meeting = 0;
  let slowest = 0;
  for (const file of files) {
    const messages = await readSession(file);
    if (messages.length < minMessages) continue;
    const before = messages.reduce((total, message) => total + messageChars(message), 0);
    const parts = makeup(messages);
    const started = Date.now();
    const result = await compact(messages, null, options);
    const ms = Date.now() - started;
    const ratio = reductionRatio(result);
    sessions++;
    sum += ratio;
    slowest = Math.max(slowest, ms);
    if (ratio >= options.targetReduction) meeting++;
    console.log(
      `${path.basename(file).slice(0, 8)} ${String(messages.length).padStart(6)} msgs ${(before / 1e6).toFixed(1).padStart(5)} MB` +
        `  results ${share(parts.results, before)}  inputs ${share(parts.inputs, before)}` +
        `  -> frees ${Math.round(ratio * 100)}% (cut ${Math.round(result.stats.dropFraction * 100)}% of old results, ${ms} ms)`,
    );
  }
  if (sessions === 0) return console.log(`no sessions with at least ${minMessages} messages under ${root}`);
  console.log(
    `mean ${Math.round((sum / sessions) * 100)}% freed | ${meeting}/${sessions} reach ${Math.round(options.targetReduction * 100)}% | slowest ${slowest} ms`,
  );
}

if (process.argv[1]?.endsWith('measure.mjs')) await main();
