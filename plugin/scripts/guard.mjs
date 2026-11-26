#!/usr/bin/env node
// PreToolUse guard for the agent-chat plugin. Deterministic: prompt injection can't argue past it.
//
//  - chat-talker:   only the agent-chat MCP tools (it talks; it can't touch the machine).
//  - chat-reviewer: nothing but its structured answer.
//  - plan-executor: only Bash commands that exactly match a menu. Pre-approved menus
//                   (/agent-chat:approve) run silently; staged ones raise the native
//                   permission prompt so the user clicks Allow or Deny per command.
//  - everyone else (the main session): may not read or send chat messages, curl the chat
//    message API, or touch the approval store. Remote text only ever reaches the talker.
//
// Output: a PreToolUse permission decision, or nothing (no opinion) for unrelated calls.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { activePlans, APPROVED, DATA_DIR, DEFAULT_MAX_RUNS, KILL_FILE, matchStep, PENDING, splitCommand, stagedPlans, writeJson } from './lib.mjs';

// Optional audit log: AGENT_CHAT_GUARD_LOG=/path/to/file records every decision.
const log = (decision, reason = '') => {
  if (!process.env.AGENT_CHAT_GUARD_LOG) return;
  try {
    appendFileSync(process.env.AGENT_CHAT_GUARD_LOG, `${new Date().toISOString()} agent=${input?.agent_type ?? '-'} tool=${input?.tool_name ?? '-'} ${decision} ${reason}\n`);
  } catch {}
};

let decided = false;
const decide = (permissionDecision, reason) => {
  decided = true;
  log(permissionDecision, reason);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason } }));
  process.exit(0);
};
const deny = (reason) => decide('deny', `agent-chat guard: ${reason}`);

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  // Fail closed only for the roles we own; we can't tell who's calling, so deny.
  deny('could not parse hook input');
}

process.on('exit', () => { if (!decided) log('none'); });
const tool = String(input.tool_name || '');
const args = input.tool_input || {};
const agent = String(input.agent_type || '');
const is = (name) => agent === `agent-chat:${name}` || agent === name;

// Any MCP server with "agent-chat" in its name: the plugin's own, a user-scope add, a second
// deployment (e.g. agent-chat-worker), or the claude.ai connector (mcp__claude_ai_agent-chat__).
const AGENT_CHAT_TOOL = /^mcp__[\w-]*agent-chat[\w-]*__/;
const CHAT_IO = /^mcp__[\w-]*agent-chat[\w-]*__(wait_for_messages|send_message|get_history|end_chat)$/;
const ALWAYS_OK = new Set(['StructuredOutput', 'ToolSearch']);

if (is('chat-talker')) {
  // The talker's whole job is the chat, so its chat calls skip the permission prompt.
  if (AGENT_CHAT_TOOL.test(tool)) decide('allow', 'agent-chat: chat tool used by the chat-talker.');
  if (ALWAYS_OK.has(tool)) process.exit(0);
  deny(`the chat talker may only use the chat tools (tried ${tool}).`);
}

if (is('chat-reviewer')) {
  if (tool === 'StructuredOutput') process.exit(0);
  deny(`the reviewer has no tools (tried ${tool}). Answer from the report alone.`);
}

if (is('plan-executor')) {
  if (tool === 'StructuredOutput') process.exit(0);
  if (tool !== 'Bash') deny(`the executor may only run approved commands with Bash (tried ${tool}).`);
  if (existsSync(KILL_FILE)) deny('the kill switch is on (run /agent-chat:stop --clear to reset). Nothing runs.');
  const argv = splitCommand(args.command);
  if (!argv) deny('commands must be a single program with plain arguments: no pipes, redirects, substitution, globs, chaining or env prefixes.');
  for (const { file, rec } of activePlans()) {
    for (const step of rec.plan.steps) {
      if (!matchStep(argv, step, rec.plan.variables)) continue;
      const used = rec.runs?.[step.id] ?? 0;
      const max = step.max_runs ?? DEFAULT_MAX_RUNS;
      if (used >= max) deny(`step [${step.id}] already ran ${used}/${max} times. Ask for a new approval round.`);
      rec.runs = { ...(rec.runs || {}), [step.id]: used + 1 };
      writeJson(file, rec);
      decide('allow', `agent-chat: matches approved plan ${rec.hash.slice(0, 12)} step [${step.id}] (${used + 1}/${max}).`);
    }
  }
  // Staged but not pre-approved: hand the decision to the user through Claude Code's own
  // permission prompt. The model can't answer that prompt, so this is still a human gate.
  for (const { file, rec } of stagedPlans()) {
    for (const step of rec.plan.steps) {
      if (!matchStep(argv, step, rec.plan.variables)) continue;
      const used = rec.runs?.[step.id] ?? 0;
      const max = step.max_runs ?? DEFAULT_MAX_RUNS;
      if (used >= max) deny(`step [${step.id}] already ran ${used}/${max} times. Ask for a new approval round.`);
      rec.runs = { ...(rec.runs || {}), [step.id]: used + 1 };
      writeJson(file, rec);
      decide('ask', `agent-chat plan ${rec.hash.slice(0, 12)}${rec.plan.goal ? ` (${rec.plan.goal})` : ''}, step [${step.id}] (${used + 1}/${max}): ${step.justification}`);
    }
  }
  deny('this command is not on any approved menu. Stop and report it as needing a new approval round; do not try variations.');
}

// ---- main session and any other agent ----

if (CHAT_IO.test(tool)) {
  deny('remote chat text must only reach the chat-talker. Run the agent-chat negotiate workflow (/agent-chat:chat) instead of reading or sending messages yourself.');
}

const text = typeof args.command === 'string' ? args.command : typeof args.url === 'string' ? args.url : '';
if ((tool === 'Bash' || tool === 'WebFetch') && /\/api\/chats\/[0-9a-z]{26}\/(messages|history)/.test(text)) {
  deny('reading or sending chat messages over HTTP is reserved for the chat-talker.');
}

// The approval store is written only by the user-invoked /agent-chat:approve command.
const touches = (s) => typeof s === 'string' && (s.includes(DATA_DIR) || s.includes(APPROVED) || s.includes(PENDING) || /agent-chat[/\\](approved|pending|KILL)|approve\.mjs/.test(s));
if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && touches(args.file_path || args.notebook_path)) {
  deny('the approval store can only be changed by the user through /agent-chat:approve.');
}
if (tool === 'Bash' && typeof args.command === 'string' && /stop\.mjs/.test(args.command) && /--clear/.test(args.command)) {
  deny('only the user can clear the kill switch (/agent-chat:stop --clear).');
}
if (tool === 'Bash' && touches(args.command) && !/stage-plan\.mjs/.test(args.command)) {
  deny('the approval store can only be changed by the user through /agent-chat:approve.');
}

process.exit(0);
