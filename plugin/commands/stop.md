---
description: Agent-chat kill switch. Revokes every approved command menu and blocks the executor. "/agent-chat:stop --clear" re-enables (user only).
argument-hint: "[--clear]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/stop.mjs" $ARGUMENTS`

Report the output above to the user verbatim.
