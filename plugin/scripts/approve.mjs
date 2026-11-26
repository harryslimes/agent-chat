#!/usr/bin/env node
// Approve a staged plan. Only ever run from the user-typed /agent-chat:approve command
// (the model can't invoke that command, and the guard hook blocks it from touching the
// approval store). Re-validates and re-hashes before approving.

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { APPROVAL_TTL_MS, APPROVED, canonical, clearPending, ensureDirs, revokeApprovedExcept, startResults, PENDING, readJson, renderPlan, sha256, validatePlan, writeJson } from './lib.mjs';

const id = (process.argv[2] || '').trim();
if (!/^[0-9a-f]{12}$/.test(id)) {
  console.log('Usage: /agent-chat:approve <12-character plan id>  (shown when the plan was staged)');
  process.exit(1);
}
ensureDirs();
const pendingFile = join(PENDING, `${id}.json`);
if (!existsSync(pendingFile)) {
  console.log(`No staged plan ${id}. It may have been approved already or never staged.`);
  process.exit(1);
}
const rec = readJson(pendingFile);
if (sha256(canonical(rec.plan)) !== rec.hash || !rec.hash.startsWith(id)) {
  console.log(`Plan ${id} was modified after staging. Refusing to approve it.`);
  process.exit(1);
}
const errs = validatePlan(rec.plan);
if (errs.length) {
  console.log(`Plan ${id} no longer passes validation:\n${errs.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
const now = Date.now();
writeJson(join(APPROVED, `${id}.json`), { ...rec, approved_at: now, expires_at: now + APPROVAL_TTL_MS, runs: {} });
unlinkSync(pendingFile);
clearPending();
revokeApprovedExcept(id);
startResults(id, rec.plan);
console.log(`APPROVED by the user until ${new Date(now + APPROVAL_TTL_MS).toLocaleTimeString()}:\n`);
console.log(renderPlan(rec.plan, id));
