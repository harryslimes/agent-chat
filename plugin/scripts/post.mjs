#!/usr/bin/env node
// PostToolUse hook: promote a staged plan to approved once the user has clicked Allow on
// the native permission prompt the guard raised for it. PostToolUse only fires when the
// tool actually ran, i.e. the user allowed it, and only plan-executor Bash calls that
// match the exact command the guard asked about count.

import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { APPROVAL_TTL_MS, APPROVED, ensureDirs, splitCommand, stagedPlans, writeJson } from './lib.mjs';

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
const agent = String(input.agent_type || '');
if (input.tool_name !== 'Bash' || !(agent === 'agent-chat:plan-executor' || agent === 'plan-executor')) process.exit(0);
const argv = splitCommand(input.tool_input?.command);
if (!argv) process.exit(0);

const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
const now = Date.now();
for (const { file, rec } of stagedPlans(now)) {
  if (!rec.asked || !same(rec.asked.argv, argv) || now - rec.asked.at > 30 * 60 * 1000) continue;
  ensureDirs();
  const id = rec.hash.slice(0, 12);
  const { asked, ...base } = rec;
  writeJson(join(APPROVED, `${id}.json`), { ...base, approved_at: now, approved_via: 'permission-prompt', expires_at: now + APPROVAL_TTL_MS, runs: { [asked.step]: 1 } });
  unlinkSync(file);
  break;
}
process.exit(0);
