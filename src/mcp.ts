import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ChatError, type ChatService } from './chat.js';
import type { Config } from './config.js';
import { safeEqual } from './secrets.js';
import { inviteText, renderForAgent, statusLine, TRUST_NOTE } from './text.js';

const INSTRUCTIONS = `agent-chat lets two people's AI agents hold a conversation while both humans watch.

Flow: the owner's agent calls create_chat and gives the returned invite to its human, who passes it to a friend.
The friend's agent calls join_chat with the chat URL and join code and gets a participant token. Then both agents
loop: wait_for_messages -> think -> send_message, until the topic is resolved and one calls end_chat with a summary.

Rules: keep the participant token private (it is only for this chat). You must read unread messages before you can
send. ${TRUST_NOTE}`;

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

async function run(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ChatError) return fail(`${e.code}: ${e.message}`);
    console.error('tool error', e);
    return fail('INTERNAL: something went wrong on the server.');
  }
}

/** Accept either a full chat URL (https://host/c/<id>...) or a bare chat ID. */
export function parseChatRef(ref: string): string {
  const m = ref.trim().match(/\/c\/([0-9a-z]{26})/i) ?? ref.trim().match(/^([0-9a-z]{26})$/i);
  return m ? m[1].toLowerCase() : '';
}

/** Owner = the owner key as a bearer token, or a live OAuth access token (for clients like claude.ai). */
export function isOwnerRequest(req: Request | undefined, cfg: Config, oauth?: { verifyAccess(t: string): boolean }): boolean {
  const auth = req?.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const token = m[1].trim();
  return safeEqual(token, cfg.ownerKey) || !!oauth?.verifyAccess(token);
}

const token = z.string().describe('Your participant token for this chat (from create_chat or join_chat).');

function buildServer(chats: ChatService, cfg: Config, isOwner: boolean, signal?: AbortSignal): McpServer {
  const server = new McpServer({ name: 'agent-chat', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  // Owner-only tools are registered only when the request carries the owner key,
  // so guests never even see them.
  if (isOwner) {
    server.registerTool(
      'create_chat',
      {
        title: 'Create an agent chat',
        description:
          'Create a new two-agent chat room and join it as the host. Returns an invite to give to your user (who passes it to the other person), your participant token, and a private viewer link for your user. After creating, call wait_for_messages to wait for the other agent to join.',
        inputSchema: z.object({
          topic: z.string().min(1).max(500).describe('What the agents should work out, e.g. "Get Sam access to my Jellyfin over Tailscale".'),
          guest_label: z.string().max(40).default('your friend').describe('What to call the other human in the invite, e.g. "Sam".'),
          host_name: z.string().max(40).optional().describe('Display name for you in the chat, e.g. "Alex\'s agent".'),
          ground_rules: z.string().max(1000).optional().describe('Optional rules shown to both agents every turn, e.g. "No secrets; config snippets only".'),
          ttl_hours: z.number().positive().optional().describe(`How long the chat stays open (default ${cfg.defaultTtlHours}, max ${cfg.maxTtlHours}).`),
          max_messages: z.number().int().positive().optional().describe(`Message cap (default and max ${cfg.maxMessages}).`),
          self_chat: z.boolean().default(false).describe('True for a chat between your own agents (e.g. your Claude Code on another device). No invite needed: the other agent, signed in as owner too, calls join_chat without a code.'),
        }),
      },
      async (a) =>
        run(() => {
          const created = chats.createChat({ topic: a.topic, groundRules: a.ground_rules, hostName: a.host_name, ttlHours: a.ttl_hours, maxMessages: a.max_messages, selfChat: a.self_chat });
          if (a.self_chat) {
            return ok(
              [
                `Self chat created: ${a.topic}`,
                ``,
                `On your other device, in an agent signed in as the owner, say: "join my agent chat". It calls join_chat with no code${' '}`,
                `(optionally chat="${created.chatId}"; with no chat it joins the newest waiting self chat).`,
                ``,
                `Private viewer link for your user: ${cfg.publicUrl}/c/${created.chatId}/view#k=${created.hostViewerKey}`,
                ``,
                `Your participant token (keep private, use it in send_message / wait_for_messages / end_chat): ${created.hostToken}`,
                `Chat ID: ${created.chatId}. Expires ${created.expiresAt}.`,
                `Next: call wait_for_messages with your token to wait for your other agent to join.`,
              ].join('\n'),
            );
          }
          return ok(
            [
              `Chat created. Show your user BOTH blocks below.`,
              ``,
              `=== 1. Invite to send to ${a.guest_label} (copy as-is) ===`,
              inviteText(cfg.publicUrl, created, a.topic, a.guest_label),
              `=== end of invite ===`,
              ``,
              `=== 2. Private viewer link for YOUR user (do not put this in the invite) ===`,
              `${cfg.publicUrl}/c/${created.chatId}/view#k=${created.hostViewerKey}`,
              ``,
              `Your participant token (keep private, use it in send_message / wait_for_messages / end_chat): ${created.hostToken}`,
              `Chat ID: ${created.chatId}. Expires ${created.expiresAt}.`,
              `Next: call wait_for_messages with your token to wait for the other agent to join.`,
            ].join('\n'),
          );
        }),
    );

    server.registerTool(
      'list_chats',
      { title: 'List chats', description: 'List recent chats created on this server (owner only).' },
      async () =>
        run(() => {
          const list = chats.listChats();
          if (!list.length) return ok('No chats yet.');
          return ok(list.map((c) => `${c.id}  ${c.status.padEnd(7)}  ${c.selfChat ? 'self ' : 'guest'}  ${c.messageCount}/${c.maxMessages} msgs  expires ${c.expiresAt}  ${c.topic}`).join('\n'));
        }),
    );

    server.registerTool(
      'close_chat',
      {
        title: 'Close a chat',
        description: 'End a chat immediately (owner only). It becomes read-only.',
        inputSchema: z.object({ chat: z.string().describe('Chat URL or ID.') }),
      },
      async (a) => run(() => ok(statusLine(chats.closeChat(parseChatRef(a.chat))))),
    );
  }

  server.registerTool(
    'join_chat',
    {
      title: 'Join an agent chat',
      description: isOwner
        ? 'Join a chat. With an invite: pass the chat URL and join code. For a self chat (between your own agents, created with self_chat: true): no code needed; pass the chat ID, or nothing to join the newest waiting self chat. Returns your participant token and the conversation so far.'
        : 'Join a chat you were invited to, using the chat URL and join code from the invite. Returns your participant token and the conversation so far.',
      inputSchema: z.object({
        chat: (isOwner ? z.string().optional() : z.string()).describe('The chat URL from the invite (or the bare chat ID).'),
        join_code: (isOwner ? z.string().optional() : z.string()).describe('The join code from the invite, e.g. "7KQ2M-X9D4F".' + (isOwner ? ' Omit for a self chat.' : '')),
        name: z.string().max(40).describe('Your display name, e.g. "Sam\'s agent".'),
      }),
    },
    async (a) =>
      run(async () => {
        const ref = a.chat ? parseChatRef(a.chat) : '';
        const { token: t, participant } = a.join_code
          ? chats.join(ref, a.join_code, a.name)
          : isOwner
            ? chats.joinAsOwner(ref || undefined, a.name)
            : (() => { throw new ChatError('BAD_INPUT', 'join_code is required.'); })();
        const { messages, chat } = chats.history(participant);
        return ok(`Joined. Your participant token (keep private): ${t}\n\n` + renderForAgent(messages, chat, participant));
      }),
  );

  server.registerTool(
    'send_message',
    {
      title: 'Send a message',
      description: 'Send a message to the other agent. Fails if you have unread messages (read them first with wait_for_messages). Max 8 KB. Never include secrets.',
      inputSchema: z.object({ token, text: z.string().min(1).describe('Your message.') }),
    },
    async (a) =>
      run(() => {
        const p = chats.authParticipant(a.token);
        const { seq, chat } = chats.send(p, a.text);
        return ok(renderForAgent([], chat, p, `Sent (seq ${seq}).`));
      }),
  );

  server.registerTool(
    'wait_for_messages',
    {
      title: 'Wait for messages',
      description: `Return new messages from the other agent. Returns immediately if anything is unread, otherwise waits up to wait_seconds (max ${cfg.maxWaitSeconds}). If it times out with nothing new, call it again.`,
      inputSchema: z.object({ token, wait_seconds: z.number().min(0).max(cfg.maxWaitSeconds).default(30) }),
    },
    async (a) =>
      run(async () => {
        const p = chats.authParticipant(a.token);
        const { messages, chat, timedOut } = await chats.read(p, a.wait_seconds, signal);
        return ok(renderForAgent(messages, chat, p, timedOut ? 'No new messages yet (timed out). Call wait_for_messages again to keep waiting.' : undefined));
      }),
  );

  server.registerTool(
    'get_history',
    {
      title: 'Get chat history',
      description: 'Return the whole conversation so far. Marks everything as read.',
      inputSchema: z.object({ token }),
    },
    async (a) =>
      run(() => {
        const p = chats.authParticipant(a.token);
        const { messages, chat } = chats.history(p);
        return ok(renderForAgent(messages, chat, p));
      }),
  );

  server.registerTool(
    'end_chat',
    {
      title: 'End the chat',
      description: 'End the chat when the topic is resolved (or should be abandoned). The summary is shown to both agents and both humans.',
      inputSchema: z.object({ token, summary: z.string().min(1).max(4000).describe('What was decided or done, and any follow-ups for the humans.') }),
    },
    async (a) =>
      run(() => {
        const p = chats.authParticipant(a.token);
        return ok(statusLine(chats.endByParticipant(p, a.summary), p));
      }),
  );

  return server;
}

export function createMcp(chats: ChatService, cfg: Config, oauth?: { verifyAccess(t: string): boolean }): McpHttpHandler {
  return createMcpHandler(
    (ctx) => buildServer(chats, cfg, isOwnerRequest(ctx.requestInfo, cfg, oauth), ctx.requestInfo?.signal),
    { legacy: 'stateless', maxRequestBodySize: 64 * 1024, onerror: (e) => console.error('mcp:', e.message) },
  );
}
