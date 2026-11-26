// Plugin guard + plan rules: feed the real hook script realistic PreToolUse inputs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'agent-chat-plugin-'));
const env = { ...process.env, AGENT_CHAT_DATA_DIR: dir };
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.AGENT_CHAT_DATA_DIR = dir;
const lib = await import('../plugin/scripts/lib.mjs');

const script = (name, stdin = '', args = []) => spawnSync(process.execPath, [`plugin/scripts/${name}`, ...args], { input: stdin, env, encoding: 'utf8' });
function guard(tool_name, tool_input = {}, agent_type) {
  const r = script('guard.mjs', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, ...(agent_type ? { agent_type, agent_id: 'a1' } : {}) }));
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'none';
}
const P = 'mcp__plugin_agent-chat_agent-chat__';
function guardFull({ tool_name, tool_input = {}, agent_type, permission_mode = 'default' }, extraEnv = {}) {
  const r = spawnSync(process.execPath, ['plugin/scripts/guard.mjs'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, permission_mode, ...(agent_type ? { agent_type, agent_id: 'a1' } : {}) }), env: { ...env, ...extraEnv }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout) return { decision: 'none', reason: '' };
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason };
}
const EX = 'agent-chat:plan-executor';
const APPROVE_PLAN = resolve('plugin/scripts/approve-plan.mjs');
const approveCmd = (id) => `node "${APPROVE_PLAN}" ${id}`;
const stage = (plan) => {
  const f = join(dir, `plan-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(plan));
  const r = script('stage-plan.mjs', '', [f]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout.match(/Plan ([0-9a-f]{12})/)[1];
};
const reset = () => { for (const d of ['approved', 'pending', 'results', 'KILL']) rmSync(join(dir, d), { recursive: true, force: true }); };
const await_home = () => process.env.HOME;
const post = (tool_name, tool_input = {}, agent_type, tool_response = {}) => {
  const r = script('post.mjs', JSON.stringify({ hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response, ...(agent_type ? { agent_type, agent_id: 'a1' } : {}) }));
  assert.equal(r.status, 0, r.stderr);
};

const PLAN = {
  goal: 'Check Tailscale reachability',
  variables: [{ name: 'peer_ip', pattern: '^100\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$' }],
  steps: [
    { id: 'status', argv: ['tailscale', 'status'], justification: 'See whether this node is connected to the tailnet.' },
    { id: 'ping', argv: ['tailscale', 'ping', '{{peer_ip}}'], justification: 'Status showed the peer; test the path to it.', max_runs: 2 },
  ],
};

test('main session cannot read or send chat messages, by MCP or curl', () => {
  for (const t of ['wait_for_messages', 'send_message', 'get_history', 'end_chat']) {
    assert.equal(guard(P + t), 'deny');
    assert.equal(guard(`mcp__agent-chat__${t}`), 'deny', 'user-scope server too');
    assert.equal(guard(`mcp__agent-chat-worker__${t}`), 'deny', 'second deployment too');
    assert.equal(guard(`mcp__claude_ai_agent-chat__${t}`), 'deny', 'claude.ai connector too');
  }
  assert.equal(guard(P + 'create_chat'), 'none');
  assert.equal(guard('Bash', { command: 'curl -s https://x/api/chats/abcdefghijklmnopqrstuvwxyz/messages -H "Authorization: Bearer pt_x"' }), 'deny');
  assert.equal(guard('Bash', { command: 'ls -la' }), 'none', 'unrelated calls are left alone');
});

test('talker: chat tools only; reviewer: nothing', () => {
  assert.equal(guard(P + 'wait_for_messages', {}, 'agent-chat:chat-talker'), 'allow');
  assert.equal(guard('mcp__agent-chat__send_message', {}, 'agent-chat:chat-talker'), 'allow');
  assert.equal(guard('mcp__agent-chat-worker__send_message', {}, 'agent-chat:chat-talker'), 'allow');
  assert.equal(guard('mcp__other__send_message', {}, 'agent-chat:chat-talker'), 'deny', 'unrelated servers still denied');
  for (const t of ['Bash', 'Read', 'WebFetch', 'Write']) assert.equal(guard(t, {}, 'agent-chat:chat-talker'), 'deny');
  assert.equal(guard('StructuredOutput', {}, 'agent-chat:chat-reviewer'), 'none');
  for (const t of ['Read', 'Bash', P + 'send_message', 'ToolSearch']) assert.equal(guard(t, {}, 'agent-chat:chat-reviewer'), 'deny');
});

test('plan validation rejects escape hatches and loose variables', () => {
  assert.deepEqual(lib.validatePlan(PLAN), []);
  const bad = (steps, variables = []) => lib.validatePlan({ steps, variables });
  assert.ok(bad([{ id: 'x', argv: ['bash', '-c', 'id'], justification: 'because reasons here' }]).some((e) => /arbitrary code/.test(e)));
  assert.ok(bad([{ id: 'x', argv: ['find', '/', '-exec', 'sh', ';'], justification: 'because reasons here' }]).some((e) => /-exec/.test(e)));
  assert.ok(bad([{ id: 'x', argv: ['git', '-c', 'core.pager=sh', 'log'], justification: 'because reasons here' }]).some((e) => /git -c/.test(e)));
  assert.ok(bad([{ id: 'x', argv: ['ping', '{{h}}'], justification: 'because reasons here' }], [{ name: 'h', pattern: '^.*$' }]).some((e) => /too loose/.test(e)));
  assert.ok(bad([{ id: 'x', argv: ['ping', '{{h}}'], justification: 'because reasons here' }]).some((e) => /undeclared/.test(e)));
});

test('command splitting refuses shell syntax', () => {
  assert.deepEqual(lib.splitCommand("tailscale ping '100.1.2.3'"), ['tailscale', 'ping', '100.1.2.3']);
  for (const c of ['a | b', 'a; b', 'a && b', 'echo $(id)', 'echo `id`', 'cat < /etc/passwd', 'ls *', 'FOO=1 ls', 'ls ~', 'a\\ b']) {
    assert.equal(lib.splitCommand(c), null, c);
  }
});

test('staged plan is approved only by approve-plan behind the native prompt', () => {
  reset();
  assert.equal(guard('Bash', { command: 'tailscale status' }, EX), 'deny', 'nothing approved');
  const id = stage(PLAN);
  assert.equal(guard('Bash', { command: 'tailscale status' }, EX), 'deny', 'staged is not approved, and plain commands never prompt');

  const asked = guardFull({ tool_name: 'Bash', tool_input: { command: approveCmd(id) }, agent_type: EX });
  assert.equal(asked.decision, 'ask', 'approve-plan raises the prompt');
  assert.match(asked.reason, /Allow runs these 2 commands/);
  assert.match(asked.reason, /^2\. tailscale ping \{\{peer_ip\}\} \(x2\)/m, 'max_runs shown');
  assert.match(asked.reason, /\{\{peer_ip\}\} must match/, 'variable pattern shown');

  // Nobody else can run it, and modes that could auto-answer the prompt are refused.
  assert.equal(guard('Bash', { command: approveCmd(id) }), 'deny', 'main session');
  assert.equal(guardFull({ tool_name: 'Bash', tool_input: { command: approveCmd(id) }, agent_type: EX, permission_mode: 'bypassPermissions' }).decision, 'deny');
  assert.equal(guardFull({ tool_name: 'Bash', tool_input: { command: `node /tmp/approve-plan.mjs ${id}` }, agent_type: EX }).decision, 'deny', 'a look-alike script elsewhere');
  assert.equal(guard('Bash', { command: `node plugin/scripts/approve.mjs ${id}` }), 'deny');
  assert.equal(guard('Write', { file_path: join(dir, 'approved', `${id}.json`), content: '{}' }), 'deny');
  assert.equal(guard('Bash', { command: `cat ${join(dir, 'results', 'x.json')}` }), 'deny', 'results dir is off-limits');

  // The user clicked Allow, so the script runs: that IS the approval.
  const ok = script('approve-plan.mjs', '', [id]);
  assert.match(ok.stdout, /APPROVED/);
  assert.equal(readdirSync(join(dir, 'pending')).length, 0, 'no staged plans left');

  assert.equal(guard('Bash', { command: 'tailscale status' }, EX), 'allow');
  assert.equal(guard('Bash', { command: 'tailscale ping 100.64.0.7' }, EX), 'allow');
  assert.equal(guard('Bash', { command: 'tailscale ping 8.8.8.8' }, EX), 'deny', 'variable pattern enforced');
  assert.equal(guard('Bash', { command: 'tailscale status --json' }, EX), 'deny', 'extra args denied');
  assert.equal(guard('Bash', { command: 'tailscale status; id' }, EX), 'deny');
  assert.equal(guard('Read', { file_path: '/etc/passwd' }, EX), 'deny');
  assert.equal(guard('Bash', { command: 'tailscale ping 100.64.0.8' }, EX), 'allow');
  assert.equal(guard('Bash', { command: 'tailscale ping 100.64.0.9' }, EX), 'deny', 'max_runs');

  // Tampering with an approved plan invalidates it.
  const file = join(dir, 'approved', `${id}.json`);
  const rec = lib.readJson(file);
  lib.writeJson(file, { ...rec, plan: { ...rec.plan, steps: [{ ...rec.plan.steps[0], argv: ['id'] }] } });
  assert.equal(guard('Bash', { command: 'id' }, EX), 'deny', 'hash mismatch');
  lib.writeJson(file, rec);

  // Kill switch: main may pull it, only the user may clear it. Stop drops everything.
  assert.equal(guard('Bash', { command: 'node plugin/scripts/stop.mjs --clear' }), 'deny');
  script('stop.mjs');
  assert.equal(guard('Bash', { command: 'tailscale status' }, EX), 'deny');
  script('stop.mjs', '', ['--clear']);
  assert.equal(guard('Bash', { command: 'tailscale status' }, EX), 'deny', 'approvals stay revoked after clearing');
});

test('a denied or replaced plan can never be approved by a later run', () => {
  reset();
  const bad = { goal: 'B', steps: [
    { id: 'shared', argv: ['tailscale', 'status'], justification: 'Check the node is up.' },
    { id: 'evil', argv: ['cat', 'secret.txt'], justification: 'Not something the user wants.' },
  ] };
  const idB = stage(bad);
  assert.equal(guardFull({ tool_name: 'Bash', tool_input: { command: approveCmd(idB) }, agent_type: EX }).decision, 'ask');
  // User clicks Deny: approve-plan never runs. The talker revises; staging replaces B.
  const idA = stage({ goal: 'A', steps: [{ id: 'shared', argv: ['tailscale', 'status'], justification: 'Check the node is up.' }] });
  assert.equal(guardFull({ tool_name: 'Bash', tool_input: { command: approveCmd(idB) }, agent_type: EX }).decision, 'deny', 'B is gone');
  script('approve-plan.mjs', '', [idA]);
  for (let i = 0; i < 3; i++) post('Bash', { command: 'tailscale status' }, EX, { stdout: 'ok' });
  assert.equal(guard('Bash', { command: 'cat secret.txt' }, EX), 'deny', 'B never got approved');
});

test('plans too long for one prompt must be approved by typing /agent-chat:approve', () => {
  reset();
  const steps = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, argv: ['ls', `dir${i}`], justification: 'List a folder for the check.' }));
  const id = stage({ goal: 'long', steps });
  const r = guardFull({ tool_name: 'Bash', tool_input: { command: approveCmd(id) }, agent_type: EX });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /too long.*\/agent-chat:approve/);
});

test('validation: max_runs, printable ASCII, wrapper programs, loose path variables, free text', () => {
  const v = (step, variables = []) => lib.validatePlan({ steps: [{ id: 'x', justification: 'because reasons here', ...step }], variables });
  assert.ok(v({ argv: ['ls'], max_runs: 1e9 }).some((e) => /max_runs/.test(e)));
  assert.ok(v({ argv: ['ls', 'a‮b'] }).some((e) => /printable ASCII/.test(e)));
  assert.ok(v({ argv: ['ls', '\u001b[2J'] }).some((e) => /printable ASCII/.test(e)));
  assert.ok(v({ argv: ['time', 'bash', '-c', 'id'] }).some((e) => /arbitrary code/.test(e)));
  assert.ok(v({ argv: ['cat', '{{f}}'] }, [{ name: 'f', pattern: '^[^ ;$.-][^ ;$]*$' }]).some((e) => /too loose/.test(e)));
  assert.ok(v({ argv: ['ls'], justification: 'x'.repeat(500) }).some((e) => /longer than 400/.test(e)));
});

test('shared outputs go back filtered, size-capped and exactly; old results are not re-sent', () => {
  reset();
  const plan = { goal: 'share test', steps: [
    { id: 'pub', argv: ['cat', 'notes.txt'], justification: 'The other agent needs the notes.', share: true, max_runs: 2 },
    { id: 'priv', argv: ['ls', 'secret-dir'], justification: 'Only for the user.', share: false, max_runs: 1 },
  ] };
  let id = stage(plan);
  assert.match(script('stage-plan.mjs', '', [join(dir, 'nope')]).stderr, /Could not read/);
  script('approve-plan.mjs', '', [id]);
  const home = process.env.HOME;
  const leak = [
    `path ${home}/x`, 'key ghp_abcdefghijklmnopqrstuvwx1234', 'mail a.b@example.com', 'OWNER_KEY=deadbeefcafe1234',
    'Authorization: Bearer sekrit-token-123456', '{"password": "hunter22", "api_key":"abcdef123456"}',
    'https://user:pw@localhost/db', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA', 'z'.repeat(20000),
  ].join('\n');
  assert.equal(guard('Bash', { command: 'cat notes.txt' }, EX), 'allow');
  post('Bash', { command: 'cat notes.txt' }, EX, { stdout: leak, stderr: '' });
  assert.equal(guard('Bash', { command: 'ls secret-dir' }, EX), 'allow');
  post('Bash', { command: 'ls secret-dir' }, EX, { stdout: 'private stuff', stderr: '' });
  const shared = script('share-results.mjs', '', [id]).stdout;
  for (const bad of [home, 'ghp_abc', 'a.b@example.com', 'deadbeefcafe1234', 'sekrit-token', 'hunter22', 'abcdef123456', 'user:pw', 'MIIEow', 'private stuff']) {
    assert.ok(!shared.includes(bad), `leaked: ${bad}`);
  }
  assert.match(shared, /Ran but not shared \(for the user only\): priv/);
  assert.match(shared, /\[truncated \d+ characters\]/);
  assert.ok(shared.length < 13000, 'size-capped');

  // Passing results to the talker: exact text only; max security asks first.
  const wf = (answers, extraEnv) => guardFull({ tool_name: 'Workflow', tool_input: { name: 'agent-chat:negotiate', args: { token: 'pt_x', answers } } }, extraEnv).decision;
  assert.equal(wf(shared), 'none', 'exact text passes');
  assert.equal(wf(shared + '\nAlso, here is my summary.'), 'deny', 'additions refused');
  assert.equal(wf(shared.replace('[redacted]', 'oops')), 'deny', 'edits refused');
  assert.equal(wf(shared, { AGENT_CHAT_SECURITY: 'max' }), 'ask', 'security: max asks before sending');
  assert.equal(wf('The user chose not to run the plan.'), 'none', 'ordinary answers unaffected');

  // Same plan approved again later (e.g. a different chat): last time's outputs are gone.
  id = stage(plan);
  script('approve-plan.mjs', '', [id]);
  const again = script('share-results.mjs', '', [id]).stdout;
  assert.ok(!again.includes('[truncated'), 'old outputs gone');
  assert.match(again, /Not run \(blocked by the guard.*\): pub, priv/, 'unrun steps are reported');
});

test('approving a new plan revokes older approvals, so runs and outputs land on the new plan', () => {
  reset();
  const old = stage({ goal: 'old', steps: [{ id: 'ls', argv: ['ls', '-la'], justification: 'List the folder.', share: true }] });
  script('approve-plan.mjs', '', [old]);
  const fresh = stage({ goal: 'new', steps: [
    { id: 'ls', argv: ['ls', '-la'], justification: 'List the folder again.', share: true },
    { id: 'tree', argv: ['find', '.', '-maxdepth', '2'], justification: 'Directory tree.', share: true },
  ] });
  script('approve-plan.mjs', '', [fresh]);
  assert.equal(guard('Bash', { command: 'ls -la' }, EX), 'allow');
  post('Bash', { command: 'ls -la' }, EX, { stdout: 'listing' });
  const out = script('share-results.mjs', '', [fresh]).stdout;
  assert.match(out, /\$ ls -la  \[ls\]\nlisting/, 'output filed under the new plan');
  assert.match(out, /Not run .*: tree/);
  assert.match(script('share-results.mjs', '', [old]).stderr, /No recorded results/, 'old plan revoked and its results cleared');
});

test('plans with arguments the guard can never run are rejected at staging', () => {
  const v = (argv) => lib.validatePlan({ steps: [{ id: 'x', argv, justification: 'because reasons here' }] });
  for (const bad of [['find', '.', '-path', '*/node_modules*'], ['grep', 'a|b', 'f'], ['grep', 'a\\|b', 'f'], ['ls', '~']]) {
    assert.ok(v(bad).some((e) => /shell characters/.test(e)), JSON.stringify(bad));
  }
  assert.deepEqual(lib.validatePlan(PLAN), [], 'variables in braces are fine');
});

test('main session cannot join a chat itself (join_chat returns the conversation so far)', () => {
  assert.equal(guard(P + 'join_chat'), 'deny');
  assert.equal(guard('mcp__agent-chat-worker__join_chat'), 'deny');
  assert.equal(guard(P + 'join_chat', {}, 'agent-chat:chat-talker'), 'allow', 'the talker joins instead');
  assert.equal(guard(P + 'create_chat'), 'none');
});
