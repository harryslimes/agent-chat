// Plugin guard + plan rules: feed the real hook script realistic PreToolUse inputs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  }
  assert.equal(guard(P + 'create_chat'), 'none');
  assert.equal(guard(P + 'join_chat'), 'none');
  assert.equal(guard('Bash', { command: 'curl -s https://x/api/chats/abcdefghijklmnopqrstuvwxyz/messages -H "Authorization: Bearer pt_x"' }), 'deny');
  assert.equal(guard('Bash', { command: 'ls -la' }), 'none', 'unrelated calls are left alone');
});

test('talker: chat tools only; reviewer: nothing', () => {
  assert.equal(guard(P + 'wait_for_messages', {}, 'agent-chat:chat-talker'), 'allow');
  assert.equal(guard('mcp__agent-chat__send_message', {}, 'agent-chat:chat-talker'), 'allow');
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

test('stage -> user approve -> executor runs only exact menu commands, with run limits and kill switch', () => {
  // Executor with nothing approved: denied.
  assert.equal(guard('Bash', { command: 'tailscale status' }, 'agent-chat:plan-executor'), 'deny');

  // Stage (grants nothing), then approve as the user would.
  const staged = script('stage-plan.mjs', JSON.stringify({ plan: PLAN }));
  assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  const id = staged.stdout.match(/\/agent-chat:approve ([0-9a-f]{12})/)[1];
  assert.match(staged.stdout, /\[ping\] tailscale ping \{\{peer_ip\}\}/);
  assert.equal(guard('Bash', { command: 'tailscale status' }, 'agent-chat:plan-executor'), 'deny', 'staged is not approved');

  // The main session can't approve on the user's behalf.
  assert.equal(guard('Bash', { command: `node plugin/scripts/approve.mjs ${id}` }), 'deny');
  assert.equal(guard('Write', { file_path: join(dir, 'approved', `${id}.json`), content: '{}' }), 'deny');

  const ok = script('approve.mjs', '', [id]);
  assert.match(ok.stdout, /APPROVED/);

  // Exact matches allowed (and auto-approved); variations denied.
  assert.equal(guard('Bash', { command: 'tailscale status' }, 'agent-chat:plan-executor'), 'allow');
  assert.equal(guard('Bash', { command: 'tailscale ping 100.64.0.7' }, 'agent-chat:plan-executor'), 'allow');
  assert.equal(guard('Bash', { command: 'tailscale ping 8.8.8.8' }, 'agent-chat:plan-executor'), 'deny', 'variable pattern enforced');
  assert.equal(guard('Bash', { command: 'tailscale status --json' }, 'agent-chat:plan-executor'), 'deny', 'extra args denied');
  assert.equal(guard('Bash', { command: 'tailscale status; id' }, 'agent-chat:plan-executor'), 'deny');
  assert.equal(guard('Read', { file_path: '/etc/passwd' }, 'agent-chat:plan-executor'), 'deny');

  // max_runs: ping allowed twice in total.
  assert.equal(guard('Bash', { command: 'tailscale ping 100.64.0.8' }, 'agent-chat:plan-executor'), 'allow');
  assert.equal(guard('Bash', { command: 'tailscale ping 100.64.0.9' }, 'agent-chat:plan-executor'), 'deny');

  // Tampering with an approved plan invalidates it.
  const file = join(dir, 'approved', `${id}.json`);
  const rec = lib.readJson(file);
  lib.writeJson(file, { ...rec, plan: { ...rec.plan, steps: [{ ...rec.plan.steps[0], argv: ['id'] }] } });
  assert.equal(guard('Bash', { command: 'id' }, 'agent-chat:plan-executor'), 'deny', 'hash mismatch');
  lib.writeJson(file, rec);
  assert.equal(guard('Bash', { command: 'tailscale status' }, 'agent-chat:plan-executor'), 'allow');

  // Kill switch: main may pull it, only the user may clear it.
  assert.equal(guard('Bash', { command: 'node plugin/scripts/stop.mjs --clear' }), 'deny');
  script('stop.mjs');
  assert.ok(existsSync(join(dir, 'KILL')));
  assert.equal(guard('Bash', { command: 'tailscale status' }, 'agent-chat:plan-executor'), 'deny');
  script('stop.mjs', '', ['--clear']);
  assert.equal(guard('Bash', { command: 'tailscale status' }, 'agent-chat:plan-executor'), 'deny', 'approvals stay revoked after clearing');
});
