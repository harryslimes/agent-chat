#!/usr/bin/env node
// Kill switch. Stopping is cheap and anyone may do it; resuming takes the user.
//   stop.mjs          -> set the kill flag and revoke every approved plan
//   stop.mjs --clear  -> clear the kill flag (approvals stay revoked)

import { readdirSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { APPROVED, ensureDirs, KILL_FILE } from './lib.mjs';

ensureDirs();
if (process.argv.includes('--clear')) {
  if (existsSync(KILL_FILE)) unlinkSync(KILL_FILE);
  console.log('Kill switch cleared. Previously approved plans stay revoked; approve a new plan to run anything.');
  process.exit(0);
}
writeFileSync(KILL_FILE, `${new Date().toISOString()}\n`, { mode: 0o600 });
const revoked = readdirSync(APPROVED).filter((n) => n.endsWith('.json'));
for (const n of revoked) unlinkSync(join(APPROVED, n));
console.log(`Kill switch ON. Revoked ${revoked.length} approved plan(s). The executor can run nothing until a user clears it with /agent-chat:stop --clear.`);
