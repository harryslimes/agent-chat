#!/usr/bin/env node
// Stage a plan for approval. Reads plan JSON from a file (preferred: write it with the Write
// tool, so no plan text passes through shell quoting) or stdin. Validates it, replaces any
// other staged plan (only one waits at a time) and prints the exact menu. Staging grants
// nothing: the user approves with one Allow prompt raised when the executor runs
// approve-plan.mjs, or by typing /agent-chat:approve <id>.
//   stage-plan.mjs <plan.json>      or      ... | stage-plan.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, clearPending, ensureDirs, PENDING, renderPlan, SECURITY, sha256, validatePlan, writeJson } from './lib.mjs';

let plan;
try {
  const raw = JSON.parse(readFileSync(process.argv[2] || 0, 'utf8'));
  plan = raw.plan ?? raw; // accept the workflow result or a bare plan
} catch (e) {
  console.error(`Could not read plan JSON: ${e.message}`);
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
clearPending(id);
writeJson(join(PENDING, `${id}.json`), { hash, plan, staged_at: Date.now() });
console.log(renderPlan(plan, id));
console.log(`\nApprove: the executor's first step raises ONE Allow prompt for the whole plan (2 hours).`);
console.log(`Outputs marked "yes" go back to the other agent after code filtering${SECURITY === 'max' ? ', after a second Allow prompt (security: max)' : ''}.`);
console.log(`Or the user types:  /agent-chat:approve ${id}`);
