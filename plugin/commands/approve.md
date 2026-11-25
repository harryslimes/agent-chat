---
description: Approve a staged agent-chat command menu (user only). Usage: /agent-chat:approve <plan id>
argument-hint: <plan id>
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/approve.mjs" $ARGUMENTS`

The output above is the result of the user's approval command. If it says APPROVED, run that plan with the agent-chat:plan-executor agent, giving it the plan exactly as printed. If it says anything else, tell the user why it wasn't approved.
