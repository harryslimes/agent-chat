#!/usr/bin/env node
// PreToolUse guard for the agent-chat plugin. Deterministic: prompt injection can't argue past it.
//
//  - chat-talker:   only the agent-chat MCP tools (it talks; it can't touch the machine).
//  - chat-reviewer: nothing but its structured answer.
//  - plan-executor: only Bash commands that exactly match an approved menu. A staged menu is
//                   approved by running `node <plugin>/scripts/approve-plan.mjs <id>`, which
//                   this hook always turns into ONE native permission prompt showing the
//                   whole menu. No model can answer that prompt; the script only runs (and
//                   approves) if the user clicks Allow.
//  - everyone else (the main session): may not read or send chat messages (MCP, curl, or
//    join_chat, which returns the conversation so far), touch the plugin's data dir, or run
//    the approval scripts. Results passed to the talker must be exactly what
//    share-results.mjs prints. Remote text only ever reaches the talker.
//
// The data-dir checks are string matching: they stop accidents and casual misuse, not a
// determined process with a shell. The real boundary is Claude Code's own permission prompts.
//
// Output: a PreToolUse permission decision, or nothing (no opinion) for unrelated calls.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activePlans, APPROVED, buildShareText, DATA_DIR, DEFAULT_MAX_RUNS, KILL_FILE, matchStep, PENDING,
  renderPlanCompact, RESULTS, SECURITY, splitCommand, stagedPlan, writeJson,
} from './lib.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const APPROVE_PLAN = join(SCRIPTS, 'approve-plan.mjs');

// Optional audit log: AGENT_CHAT_GUARD_LOG=/path/to/file records every decision.
const log = (decision, reason = '') => {
  if (!process.env.AGENT_CHAT_GUARD_LOG) return;
  try {
    appendFileSync(process.env.AGENT_CHAT_GUARD_LOG, `${new Date().toISOString()} agent=${input?.agent_type ?? '-'} tool=${input?.tool_name ?? '-'} ${decision} ${reason.split('\n')[0]}\n`);
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
const mode = String(input.permission_mode || '');
const is = (name) => agent === `agent-chat:${name}` || agent === name;

// Any MCP server with "agent-chat" in its name: the plugin's own, a user-scope add, a second
// deployment (e.g. agent-chat-worker), or the claude.ai connector (mcp__claude_ai_agent-chat__).
const AGENT_CHAT_TOOL = /^mcp__[\w-]*agent-chat[\w-]*__/;
const CHAT_IO = /^mcp__[\w-]*agent-chat[\w-]*__(wait_for_messages|send_message|get_history|end_chat|join_chat)$/;
const ALWAYS_OK = new Set(['StructuredOutput', 'ToolSearch']);
const HANDBACK = new Set(['StructuredOutput', 'SubagentHandback']);

if (is('chat-talker')) {
  // The talker's whole job is the chat, so its chat calls skip the permission prompt.
  if (AGENT_CHAT_TOOL.test(tool)) decide('allow', 'agent-chat: chat tool used by the chat-talker.');
  if (ALWAYS_OK.has(tool)) process.exit(0);
  deny(`the chat talker may only use the chat tools (tried ${tool}).`);
}

if (is('chat-reviewer')) {
  if (HANDBACK.has(tool)) process.exit(0);
  deny(`the reviewer has no tools (tried ${tool}). Answer from the report alone.`);
}

if (is('plan-executor')) {
  if (HANDBACK.has(tool)) process.exit(0);
  if (tool !== 'Bash') deny(`the executor may only run approved commands with Bash (tried ${tool}).`);
  if (existsSync(KILL_FILE)) deny('the kill switch is on (run /agent-chat:stop --clear to reset). Nothing runs.');
  const argv = splitCommand(args.command);
  if (!argv) deny('commands must be a single program with plain arguments: no pipes, redirects, substitution, globs, chaining or env prefixes.');

  // Approving a staged plan: always the user's call, through the native prompt.
  if (argv.length === 3 && argv[0] === 'node' && resolve(argv[1]) === APPROVE_PLAN && /^[0-9a-f]{12}$/.test(argv[2])) {
    const staged = stagedPlan(argv[2]);
    if (!staged) deny(`no staged plan ${argv[2]} (expired, replaced by a newer plan, or never staged).`);
    if (mode === 'bypassPermissions' || mode === 'dontAsk') deny(`permission mode "${mode}" could approve this without asking the user. The user must type /agent-chat:approve ${argv[2]} instead.`);
    const prompt = renderPlanCompact(staged.rec.plan, argv[2]);
    if (!prompt) deny(`plan ${argv[2]} is too long to show in one permission prompt. The user must type /agent-chat:approve ${argv[2]} after reading the full menu.`);
    decide('ask', prompt);
  }

  let exhausted = null;
  for (const { file, rec } of activePlans()) {
    for (const step of rec.plan.steps) {
      if (!matchStep(argv, step, rec.plan.variables)) continue;
      const used = rec.runs?.[step.id] ?? 0;
      const max = step.max_runs ?? DEFAULT_MAX_RUNS;
      if (used >= max) {
        exhausted = `step [${step.id}] already ran ${used}/${max} times. Ask for a new approval round.`;
        continue;
      }
      rec.runs = { ...(rec.runs || {}), [step.id]: used + 1 };
      writeJson(file, rec);
      decide('allow', `agent-chat: matches approved plan ${rec.hash.slice(0, 12)} step [${step.id}] (${used + 1}/${max}).`);
    }
  }
  if (exhausted) deny(exhausted);
  deny('this command is not on any approved menu. If the plan is staged but not approved yet, run its approve-plan command first. Otherwise stop and report it as needing a new approval round; do not try variations.');
}

// ---- main session and any other agent ----

if (CHAT_IO.test(tool)) {
  deny('remote chat text must only reach the chat-talker. Run the agent-chat negotiate workflow instead (to join a chat, pass join_url and join_code to it).');
}

const text = typeof args.command === 'string' ? args.command : typeof args.url === 'string' ? args.url : '';
if ((tool === 'Bash' || tool === 'WebFetch') && /\/api\/chats\/[0-9a-z]{26}\/(messages|history|join)/.test(text)) {
  deny('reading or sending chat messages over HTTP is reserved for the chat-talker.');
}

// Results handed to the talker must be byte-for-byte what share-results.mjs prints.
if (tool === 'Workflow') {
  let wargs = args.args;
  if (typeof wargs === 'string') {
    try {
      wargs = JSON.parse(wargs);
    } catch {}
  }
  const answers = wargs && typeof wargs === 'object' ? wargs.answers : undefined;
  const m = typeof answers === 'string' && answers.match(/Results of the approved plan ([0-9a-f]{12})/);
  if (m) {
    const expected = buildShareText(m[1]);
    if (expected === null) deny(`no recorded results for plan ${m[1]}.`);
    if (answers !== expected) deny(`answers must be exactly the output of share-results.mjs ${m[1]}, unedited and with nothing added.`);
    if (SECURITY === 'max') decide('ask', `agent-chat (security: max): send the filtered results of plan ${m[1]} shown above to the other agent?`);
  }
}

// The data dir (staged/approved plans, results, kill flag) and the approval scripts are off-limits.
const touches = (s) => typeof s === 'string' && (
  s.includes(DATA_DIR) || s.includes(APPROVED) || s.includes(PENDING) || s.includes(RESULTS)
  || /agent-chat[/\\](approved|pending|results|KILL)|approve(-plan)?\.mjs/.test(s));
if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && touches(args.file_path || args.notebook_path)) {
  deny('the plugin data dir and approval scripts can only be changed by the user.');
}
if (tool === 'Bash' && typeof args.command === 'string' && /stop\.mjs/.test(args.command) && /--clear/.test(args.command)) {
  deny('only the user can clear the kill switch (/agent-chat:stop --clear).');
}
if (tool === 'Bash' && touches(args.command)) {
  deny('the plugin data dir and approval scripts are off-limits: approval happens through the executor prompt or /agent-chat:approve.');
}

process.exit(0);
