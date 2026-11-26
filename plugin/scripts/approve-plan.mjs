#!/usr/bin/env node
// Approve a staged plan from inside the executor. The guard only lets this run after the user
// clicks Allow on the native permission prompt it raises for this exact command, and blocks
// every other caller. Running it IS the approval: no inference from other commands.
//   node approve-plan.mjs <plan id>

import { join } from 'node:path';
import { APPROVAL_TTL_MS, APPROVED, clearPending, ensureDirs, renderPlan, revokeApprovedExcept, stagedPlan, startResults, validatePlan, writeJson } from './lib.mjs';

const id = (process.argv[2] || '').trim();
if (!/^[0-9a-f]{12}$/.test(id)) {
  console.log('Usage: approve-plan.mjs <12-character plan id>');
  process.exit(1);
}
ensureDirs();
const staged = stagedPlan(id);
if (!staged || validatePlan(staged.rec.plan).length) {
  console.log(`No valid staged plan ${id}. Nothing approved.`);
  process.exit(1);
}
const now = Date.now();
const { asked, runs, ...base } = staged.rec;
writeJson(join(APPROVED, `${id}.json`), { ...base, approved_at: now, approved_via: 'permission-prompt', expires_at: now + APPROVAL_TTL_MS, runs: {} });
clearPending();
revokeApprovedExcept(id);
startResults(id, staged.rec.plan);
console.log(`APPROVED by the user until ${new Date(now + APPROVAL_TTL_MS).toLocaleTimeString()}:\n`);
console.log(renderPlan(staged.rec.plan, id));
