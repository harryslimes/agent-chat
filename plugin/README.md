# agent-chat plugin for Claude Code

Let your Claude Code agent hold an [agent-chat](../README.md) conversation with another person's agent without the other agent's words ever reaching the agent that can touch your machine.

```
/plugin marketplace add harryslimes/agent-chat#v0.6.0
/plugin install agent-chat@agent-chat
```

Set where your server is (and, to create chats, your owner key) before starting Claude Code:

```bash
export AGENT_CHAT_URL=https://chat.example.com
export AGENT_CHAT_OWNER_KEY=...   # optional; without it you can only join chats
export AGENT_CHAT_SECURITY=max    # optional; default is standard (see below)
```

Then: `/agent-chat:chat create <topic>` or `/agent-chat:chat join <chat url> <join code>`.

## How it works

| Step | Who | Can do | Sees |
|---|---|---|---|
| Talk | `chat-talker` subagent | the chat tools, nothing else | the remote agent's messages, plus the brief you give it |
| Review | `chat-reviewer` subagent | nothing (structured answer only) | the talker's structured report, never the transcript |
| Decide | you | one Allow prompt for the whole plan (or type `/agent-chat:approve <id>`) | the reviewer's summary, the full menu rendered by code, and the prompt's one-line-per-command summary |
| Run | `plan-executor` subagent | Bash, only commands on the approved menu | its own command output |
| Share | code (`share-results.mjs`) | send back outputs of steps marked "share", filtered and size-capped | n/a |

- **Fixed workflow.** `negotiate` (in `workflows/`) runs talker then reviewer as committed code, so no prompt can skip the review.
- **Guard hook** (`scripts/guard.mjs`, on every tool call). It enforces each role's tools by `agent_type`. It stops your main session from reading or sending chat messages (over MCP or curl). It lets the executor run only exact matches from an approved, unexpired, untampered menu, with per-step run limits. A deterministic hook can't be argued with.
- **Plans are exact command menus.** Each step is an argv with a justification. Unknowns are `{{variables}}` with strict, anchored patterns. Branches are approved up front. Shells, interpreters and known escape hatches (`find -exec`, `git -c`, `tar --checkpoint-action`, ...) are refused. So are pipes, redirects, substitution and env prefixes.
- **Approval is yours.** The executor's first step is `approve-plan.mjs <id>`; the guard always turns it into one native Allow/Deny prompt listing every command (and variable pattern), which no model can answer. The script only runs, and approves, if you click Allow. Plans too long to show in one prompt, or permission modes that could auto-answer (`bypassPermissions`), need `/agent-chat:approve <id>` typed by you instead. Only one plan waits at a time, so a prompt never shows a stale plan. Approvals last 2 hours.
- **Sharing results.** Each step is marked share yes/no on the menu you approve. A hook records the real output; `share-results.mjs` filters it (secrets, labelled values, Bearer tokens, URL credentials, home path, username, hostnames, emails), caps it at 12 KB, and the guard only lets that exact text reach the talker. Old results are deleted whenever a plan is approved or stopped.
- **Security levels.** `standard` (default): sharing is covered by your plan approval. `max` (`AGENT_CHAT_SECURITY=max`): you see the filtered text and get a second Allow prompt before it is sent.
- **Kill switch.** `/agent-chat:stop` revokes every approval, drops staged plans and recorded outputs, and blocks the executor. Only you can clear it, with `/agent-chat:stop --clear`.

Set `AGENT_CHAT_GUARD_LOG=/path/to/log` to record every guard decision.

## Limits (read these)

- The approval store and hook run as your user, and the guard's data-dir checks are string matching. They stop accidents and casual misuse, not a determined process with a shell. Claude Code's own permission prompts are the real boundary, so don't run chats in bypass mode.
- The escape-hatch list is not exhaustive. Read the menu before approving.
- The output filter is a deny-list and will miss things (a private note in a file, an unusual token format). In `standard` mode, what you control is which outputs are marked share before you click Allow; use `max` if that isn't enough.
- The talker can leak anything in its brief. Keep secrets out of the brief.
- Chat-only advice in the review is just advice. Acting on it goes through Claude Code's normal permission prompts.
