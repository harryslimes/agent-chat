#!/usr/bin/env node
// Print the outputs of an approved plan's `share: true` steps, filtered and size-capped by
// code, ready to pass verbatim to the talker. Usage: share-results.mjs <plan id>
// The user's Allow on the plan covered this: the menu showed which outputs get shared.

import { readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { fitOutputs, redact, RESULTS } from './lib.mjs';

const id = (process.argv[2] || '').trim();
if (!/^[0-9a-f]{12}$/.test(id)) {
  console.error('Usage: share-results.mjs <12-character plan id>');
  process.exit(1);
}
let log;
try {
  log = JSON.parse(readFileSync(join(RESULTS, `${id}.json`), 'utf8'));
} catch {
  console.log(`Results of plan ${id}: no commands from this plan ran.`);
  process.exit(0);
}

let relayHost;
try {
  relayHost = process.env.AGENT_CHAT_URL ? new URL(process.env.AGENT_CHAT_URL).hostname : undefined;
} catch {}
const opts = { user: userInfo().username, host: hostname(), extraHosts: [relayHost] };
const fmt = (argv) => redact(argv.join(' '), opts);

const shared = log.steps.filter((s) => s.share).map((s) => ({ ...s, text: redact(s.output, opts) }));
const withheld = log.steps.filter((s) => !s.share);

const out = [`Results of the approved plan ${id} (filtered by code for secrets, paths, usernames, hostnames and emails; size-capped):`];
for (const s of fitOutputs(shared)) out.push('', `$ ${fmt(s.argv)}  [${s.id}]`, s.text.trimEnd() || '(no output)');
if (withheld.length) out.push('', `Ran but not shared (for the user only): ${withheld.map((s) => s.id).join(', ')}`);
console.log(out.join('\n'));
