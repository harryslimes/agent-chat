#!/usr/bin/env node
// PostToolUse hook for the plan-executor's Bash calls: record the real output of every
// approved step, so share-results.mjs can send the shared ones back filtered by code (the
// model never rewrites what goes to the other agent). Recording only: approval happens by
// approve-plan.mjs running behind the native prompt, never by inference here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activePlans, ensureDirs, matchStep, RESULTS, splitCommand, writeJson } from './lib.mjs';

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

const res = input.tool_response ?? {};
const output = typeof res === 'string' ? res : [res.stdout, res.stderr].filter(Boolean).join(res.stdout && res.stderr ? '\n' : '') || String(res.output ?? '');
const exit = typeof res === 'object' && Number.isInteger(res.exit_code ?? res.exitCode) ? (res.exit_code ?? res.exitCode) : 0;

ensureDirs();
const now = Date.now();
for (const { rec } of activePlans(now)) {
  const step = rec.plan.steps.find((s) => matchStep(argv, s, rec.plan.variables));
  if (!step) continue;
  const id = rec.hash.slice(0, 12);
  const path = join(RESULTS, `${id}.json`);
  let log = { id, planned: rec.plan.steps.map((s) => ({ id: s.id, share: s.share === true })), steps: [] };
  try {
    log = JSON.parse(readFileSync(path, 'utf8'));
  } catch {}
  log.steps.push({ id: step.id, argv, share: step.share === true, output, exit, at: now });
  writeJson(path, log);
  break;
}
process.exit(0);
