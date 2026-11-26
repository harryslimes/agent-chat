# agent-chat plugin for Claude Code

Let your Claude Code agent hold an [agent-chat](../README.md) conversation with another person's agent without the other agent's words ever reaching the agent that can touch your machine.

```
/plugin marketplace add harryslimes/agent-chat#v0.2.0
/plugin install agent-chat@agent-chat
```

Set where your server is (and, to create chats, your owner key) before starting Claude Code:

```bash
export AGENT_CHAT_URL=https://chat.example.com
export AGENT_CHAT_OWNER_KEY=...   # optional; without it you can only join chats
```

Then: `/agent-chat:chat create <topic>` or `/agent-chat:chat join <chat url> <join code>`.

## How it works

| Step | Who | Can do | Sees |
|---|---|---|---|
| Talk | `chat-talker` subagent | the chat tools, nothing else | the remote agent's messages, plus the brief you give it |
| Review | `chat-reviewer` subagent | nothing (structured answer only) | the talker's structured report, never the transcript |
| Decide | you | click Allow on each command's native permission prompt (or pre-approve the menu with `/agent-chat:approve <id>`) | the reviewer's summary and the exact commands, rendered by code |
| Run | `plan-executor` subagent | Bash, only commands on the approved menu | its own command output |

- **Fixed workflow.** `negotiate` (in `workflows/`) runs talker then reviewer as committed code, so no prompt can skip the review.
- **Guard hook** (`scripts/guard.mjs`, on every tool call). It enforces each role's tools by `agent_type`. It stops your main session from reading or sending chat messages (over MCP or curl). It lets the executor run only exact matches from an approved, unexpired, untampered menu, with per-step run limits. A deterministic hook can't be argued with.
- **Plans are exact command menus.** Each step is an argv with a justification. Unknowns are `{{variables}}` with strict, anchored patterns. Branches are approved up front. Shells, interpreters and known escape hatches (`find -exec`, `git -c`, `tar --checkpoint-action`, ...) are refused. So are pipes, redirects, substitution and env prefixes.
- **Approval is yours.** Each staged command raises Claude Code's own Allow/Deny prompt, which no model can answer. To skip the prompts you can pre-approve a whole menu with `/agent-chat:approve <id>`, a user-only command (`disable-model-invocation`); the hook blocks the model from writing the approval store. Approvals last 2 hours.
- **Kill switch.** `/agent-chat:stop` revokes every approval and blocks the executor. Only you can clear it, with `/agent-chat:stop --clear`.

Set `AGENT_CHAT_GUARD_LOG=/path/to/log` to record every guard decision.

## Limits (read these)

- The approval store and hook run as your user. A main session that was itself compromised some other way could, with effort, bypass them. OS-level isolation (a container for the executor) is planned for v0.3.
- The escape-hatch list is not exhaustive. A menu should still be read before it's approved: the menu is rendered by code precisely so that what you read is what runs.
- The talker can leak anything in its brief. Keep secrets out of the brief.
- Chat-only advice in the review is just advice. Acting on it goes through Claude Code's normal permission prompts.
