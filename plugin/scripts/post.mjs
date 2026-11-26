#!/usr/bin/env node
// PostToolUse hook for the plan-executor's Bash calls. PostToolUse only fires when the tool
// actually ran, i.e. the guard allowed it or the user clicked Allow on its prompt.
//  1. Promote a staged plan to approved when the user allowed the command the guard asked about.
//  2. Record the real output of every approved step, so share-results.mjs can send it back
//     filtered by code (the model never rewrites what goes to the other agent).

import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { activePlans, APPROVAL_TTL_MS, APPROVED, ensureDirs, matchStep, RESULTS, splitCommand, stagedPlans, writeJson } from './lib.mjs';

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
ensureDirs();

for (const { file, rec } of stagedPlans(now)) {
  if (!rec.asked || !same(rec.asked.argv, argv) || now - rec.asked.at > 30 * 60 * 1000) continue;
  const id = rec.hash.slice(0, 12);
  const { asked, ...base } = rec;
  writeJson(join(APPROVED, `${id}.json`), { ...base, approved_at: now, approved_via: 'permission-prompt', expires_at: now + APPROVAL_TTL_MS, runs: { [asked.step]: 1 } });
  unlinkSync(file);
  break;
}

const res = input.tool_response ?? {};
const output = typeof res === 'string' ? res : [res.stdout, res.stderr].filter(Boolean).join(res.stdout && res.stderr ? '\n' : '') || (res.output ?? '');
for (const { rec } of activePlans(now)) {
  const step = rec.plan.steps.find((s) => matchStep(argv, s, rec.plan.variables));
  if (!step) continue;
  const id = rec.hash.slice(0, 12);
  const path = join(RESULTS, `${id}.json`);
  let log = { id, steps: [] };
  try {
    log = JSON.parse(readFileSync(path, 'utf8'));
  } catch {}
  log.steps.push({ id: step.id, argv, share: step.share === true, output: String(output), at: now });
  writeJson(path, log);
  break;
}
process.exit(0);
