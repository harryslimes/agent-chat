#!/usr/bin/env node
// Stage a plan for human approval. Reads plan JSON on stdin, validates it, stores it as
// pending/<hash>.json and prints the exact menu. Staging grants nothing by itself: each
// command still needs the user's click on the native permission prompt, or the user can
// pre-approve the whole menu by typing /agent-chat:approve <id>.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, ensureDirs, PENDING, renderPlan, sha256, validatePlan, writeJson } from './lib.mjs';

let plan;
try {
  const raw = JSON.parse(readFileSync(0, 'utf8'));
  plan = raw.plan ?? raw; // accept the workflow result or a bare plan
} catch (e) {
  console.error(`Could not read plan JSON on stdin: ${e.message}`);
  process.exit(1);
}

const errs = validatePlan(plan);
if (errs.length) {
  console.log('This plan cannot be approved as written:');
  for (const e of errs) console.log(`  - ${e}`);
  console.log('\nAsk the talker for a revised plan (rerun the negotiate workflow with these problems as answers).');
  process.exit(2);
}

ensureDirs();
const hash = sha256(canonical(plan));
const id = hash.slice(0, 12);
writeJson(join(PENDING, `${id}.json`), { hash, plan, staged_at: Date.now() });
console.log(renderPlan(plan, id));
console.log(`\nWhen run, each command asks for your OK with Claude Code's Allow/Deny prompt.`);
console.log(`To pre-approve all of them for 2 hours instead, type:  /agent-chat:approve ${id}`);
