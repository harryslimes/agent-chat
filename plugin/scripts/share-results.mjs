#!/usr/bin/env node
// Print the outputs of an approved plan's `share: true` steps, filtered and size-capped by
// code, ready to pass verbatim to the talker as `answers`. Usage: share-results.mjs <plan id>
// The guard checks that what reaches the talker is exactly this text.

import { buildShareText, SECURITY } from './lib.mjs';

const id = (process.argv[2] || '').trim();
if (!/^[0-9a-f]{12}$/.test(id)) {
  console.error('Usage: share-results.mjs <12-character plan id>');
  process.exit(1);
}
const text = buildShareText(id);
if (text === null) {
  console.error(`No recorded results for plan ${id}: none of its commands ran.`);
  process.exit(1);
}
if (SECURITY === 'max') console.error('security: max. Show this text to the user; sending it raises an Allow prompt.');
process.stdout.write(text);
