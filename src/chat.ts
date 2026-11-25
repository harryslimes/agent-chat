import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';
import { cleanName, cleanText, findSecret, RateLimiter } from './guards.js';
import { hash, newChatId, newJoinCode, newToken, normaliseJoinCode, safeEqual } from './secrets.js';

export type Role = 'host' | 'guest';
export type Status = 'waiting' | 'active' | 'ended' | 'locked' | 'expired';

export class ChatError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) {
    super(message);
  }
}

interface ChatRow {
  id: string;
  topic: string;
  ground_rules: string;
  status: string;
  join_code_hash: string;
  failed_joins: number;
  max_messages: number;
  created_at: number;
  expires_at: number;
  ended_at: number | null;
  ended_by: string | null;
  end_summary: string | null;
}

interface ParticipantRow {
  id: number;
  chat_id: string;
  role: Role;
  name: string;
  last_read_seq: number;
}

interface MessageRow {
  seq: number;
  sender: string;
  sender_name: string;
  kind: string;
  body: string;
  created_at: number;
}

export interface Message {
  seq: number;
  from: 'host' | 'guest' | 'system';
  name: string;
  kind: 'text' | 'system' | 'end';
  text: string;
  at: string;
}

export interface ChatInfo {
  id: string;
  topic: string;
  groundRules: string;
  status: Status;
  createdAt: string;
  expiresAt: string;
  participants: Array<{ role: Role; name: string }>;
  messageCount: number;
  maxMessages: number;
  endedBy: string | null;
  endSummary: string | null;
}

export interface Participant {
  id: number;
  chatId: string;
  role: Role;
  name: string;
}

export interface CreateChatInput {
  topic: string;
  groundRules?: string;
  hostName?: string;
  ttlHours?: number;
  maxMessages?: number;
}

export interface CreatedChat {
  chatId: string;
  joinCode: string;
  hostToken: string;
  hostViewerKey: string;
  guestViewerKey: string;
  expiresAt: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const isLive = (s: Status) => s === 'waiting' || s === 'active';

export class ChatService {
  private waiters = new Map<string, Set<() => void>>();
  private sendLimiter: RateLimiter;

  constructor(private db: DatabaseSync, private cfg: Config) {
    this.sendLimiter = new RateLimiter(cfg.sendPerMinute, 60_000);
  }

  // ---------- owner operations ----------

  createChat(input: CreateChatInput): CreatedChat {
    const topic = cleanText(input.topic).trim().slice(0, 500);
    if (!topic) throw new ChatError('BAD_INPUT', 'topic is required');
    const groundRules = cleanText(input.groundRules ?? '').trim().slice(0, 1000);
    const ttlHours = Math.min(Math.max(input.ttlHours ?? this.cfg.defaultTtlHours, 0.25), this.cfg.maxTtlHours);
    const maxMessages = Math.min(Math.max(Math.floor(input.maxMessages ?? this.cfg.maxMessages), 2), this.cfg.maxMessages);

    const now = Date.now();
    const chatId = newChatId();
    const joinCode = newJoinCode();
    const hostToken = newToken('pt');
    const hostViewerKey = newToken('vk');
    const guestViewerKey = newToken('vk');
    const expiresAt = now + ttlHours * 3_600_000;

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO chats (id, topic, ground_rules, status, join_code_hash, max_messages, created_at, expires_at)
           VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?)`,
        )
        .run(chatId, topic, groundRules, hash(normaliseJoinCode(joinCode)), maxMessages, now, expiresAt);
      this.db
        .prepare(`INSERT INTO participants (chat_id, role, name, token_hash, joined_at) VALUES (?, 'host', ?, ?, ?)`)
        .run(chatId, cleanName(input.hostName ?? 'host agent'), hash(hostToken), now);
      const v = this.db.prepare(`INSERT INTO viewers (chat_id, label, key_hash) VALUES (?, ?, ?)`);
      v.run(chatId, 'host', hash(hostViewerKey));
      v.run(chatId, 'guest', hash(guestViewerKey));
      this.addMessage(chatId, 'system', 'system', 'system', `Chat created. Topic: ${topic}`);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { chatId, joinCode, hostToken, hostViewerKey, guestViewerKey, expiresAt: iso(expiresAt) };
  }

  listChats(): ChatInfo[] {
    const rows = this.db.prepare(`SELECT * FROM chats ORDER BY created_at DESC LIMIT 100`).all() as unknown as ChatRow[];
    return rows.map((r) => this.info(r));
  }

  closeChat(chatId: string): ChatInfo {
    const chat = this.getChat(chatId);
    this.end(chat, 'owner', 'Closed by the owner.');
    return this.info(this.getChat(chatId));
  }

  // ---------- joining ----------

  join(chatId: string, code: string, name: string): { token: string; participant: Participant; chat: ChatInfo } {
    const chat = this.findChat(chatId);
    // Same error for "no such chat" and "wrong code" so IDs can't be probed.
    const denied = new ChatError('JOIN_DENIED', 'Chat not found or join code incorrect.', 403);
    if (!chat) throw denied;
    const status = this.status(chat);
    if (status === 'locked') throw new ChatError('LOCKED', 'This chat is locked after too many failed join attempts. Ask the host for a new chat.', 403);
    if (status === 'expired' || status === 'ended') throw new ChatError('CLOSED', `This chat has ${status}.`, 410);
    if (status === 'active') throw new ChatError('FULL', 'This chat already has both participants.', 409);

    if (!safeEqual(hash(normaliseJoinCode(code)), chat.join_code_hash)) {
      const failed = chat.failed_joins + 1;
      const lock = failed >= this.cfg.maxJoinFailures;
      this.db.prepare(`UPDATE chats SET failed_joins = ?, status = CASE WHEN ? THEN 'locked' ELSE status END WHERE id = ?`).run(failed, lock ? 1 : 0, chat.id);
      if (lock) this.addMessage(chat.id, 'system', 'system', 'system', 'Chat locked: too many failed join attempts.');
      throw denied;
    }

    const token = newToken('pt');
    const cleanedName = cleanName(name);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO participants (chat_id, role, name, token_hash, joined_at) VALUES (?, 'guest', ?, ?, ?)`).run(chat.id, cleanedName, hash(token), Date.now());
      // The code is single-use: the room is now full and the code is useless.
      this.db.prepare(`UPDATE chats SET status = 'active' WHERE id = ?`).run(chat.id);
      this.addMessage(chat.id, 'system', 'system', 'system', `${cleanedName} joined. Both agents are here.`);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    const participant = this.authParticipant(token, chat.id);
    // The joiner gets the history in the join response, so mark it read: their first
    // read then genuinely waits for the other agent instead of returning system notices.
    const last = this.messagesAfter(chat.id, 0).at(-1);
    if (last) this.markRead(participant, last.seq);
    return { token, participant, chat: this.info(this.getChat(chat.id)) };
  }

  // ---------- participant operations ----------

  /** Resolve a participant token. If chatId is given, the token must belong to that chat. */
  authParticipant(token: string, chatId?: string): Participant {
    const row = this.db.prepare(`SELECT id, chat_id, role, name, last_read_seq FROM participants WHERE token_hash = ?`).get(hash(token)) as unknown as ParticipantRow | undefined;
    if (!row || (chatId && row.chat_id !== chatId)) throw new ChatError('BAD_TOKEN', 'Invalid participant token.', 401);
    return { id: row.id, chatId: row.chat_id, role: row.role, name: row.name };
  }

  send(p: Participant, rawText: string): { seq: number; chat: ChatInfo } {
    const chat = this.getChat(p.chatId);
    const status = this.status(chat);
    if (!isLive(status)) throw new ChatError('CLOSED', `This chat has ${status}; no more messages can be sent.`, 410);
    if (status === 'waiting') throw new ChatError('NOT_YET', 'The other agent has not joined yet. Wait for them first (MCP: wait_for_messages; HTTP: GET /api/chats/<id>/messages?wait=30).', 409);

    const text = cleanText(rawText).trim();
    if (!text) throw new ChatError('BAD_INPUT', 'Message is empty.');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.cfg.maxMessageBytes) throw new ChatError('TOO_LONG', `Message is ${bytes} bytes; the limit is ${this.cfg.maxMessageBytes}. Split it or summarise.`, 413);
    const secret = findSecret(text);
    if (secret) throw new ChatError('SECRET_DETECTED', `Message rejected: it looks like it contains a ${secret}. Never share credentials in this chat; redact it and resend.`, 422);

    // Inbox gate: read what the other side said before talking over them.
    const unread = this.unreadCount(p);
    if (unread > 0) throw new ChatError('UNREAD', `You have ${unread} unread message(s). Read them first (MCP: wait_for_messages; HTTP: GET /api/chats/<id>/messages). It returns immediately; then reply.`, 409);
    if (!this.sendLimiter.hit(`p${p.id}`)) throw new ChatError('RATE_LIMITED', `Slow down: at most ${this.cfg.sendPerMinute} messages per minute.`, 429);

    const seq = this.addMessage(p.chatId, p.role, p.name, 'text', text);
    this.markRead(p, seq);
    if (this.textCount(p.chatId) >= chat.max_messages) {
      this.end(chat, 'system', `Message limit (${chat.max_messages}) reached.`);
    }
    return { seq, chat: this.info(this.getChat(p.chatId)) };
  }

  /**
   * Return messages from others the participant hasn't read yet, waiting up to
   * waitSeconds for one to arrive. Advances the participant's read cursor.
   */
  async read(p: Participant, waitSeconds: number, signal?: AbortSignal): Promise<{ messages: Message[]; chat: ChatInfo; timedOut: boolean }> {
    const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), this.cfg.maxWaitSeconds) * 1000;
    for (;;) {
      const messages = this.unread(p);
      const chat = this.getChat(p.chatId);
      const status = this.status(chat);
      if (messages.length > 0 || !isLive(status) || Date.now() >= deadline || signal?.aborted) {
        if (messages.length > 0) this.markRead(p, messages[messages.length - 1].seq);
        return { messages, chat: this.info(chat), timedOut: messages.length === 0 && isLive(status) };
      }
      await this.waitForChange(p.chatId, deadline - Date.now(), signal);
    }
  }

  history(p: Participant): { messages: Message[]; chat: ChatInfo } {
    const messages = this.messagesAfter(p.chatId, 0);
    if (messages.length) this.markRead(p, messages[messages.length - 1].seq);
    return { messages, chat: this.info(this.getChat(p.chatId)) };
  }

  endByParticipant(p: Participant, summary: string): ChatInfo {
    const chat = this.getChat(p.chatId);
    this.end(chat, `${p.role} agent (${p.name})`, cleanText(summary).trim().slice(0, 4000) || '(no summary)');
    return this.info(this.getChat(p.chatId));
  }

  // ---------- viewers (the humans) ----------

  authViewer(chatId: string, key: string): 'host' | 'guest' {
    const row = this.db.prepare(`SELECT label FROM viewers WHERE chat_id = ? AND key_hash = ?`).get(chatId, hash(key)) as { label: 'host' | 'guest' } | undefined;
    if (!row) throw new ChatError('BAD_VIEWER_KEY', 'Invalid viewer link.', 401);
    return row.label;
  }

  async view(chatId: string, afterSeq: number, waitSeconds: number, signal?: AbortSignal): Promise<{ messages: Message[]; chat: ChatInfo }> {
    const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), this.cfg.maxWaitSeconds) * 1000;
    for (;;) {
      const messages = this.messagesAfter(chatId, afterSeq);
      const chat = this.getChat(chatId);
      if (messages.length > 0 || !isLive(this.status(chat)) || Date.now() >= deadline || signal?.aborted) {
        return { messages, chat: this.info(chat) };
      }
      await this.waitForChange(chatId, deadline - Date.now(), signal);
    }
  }

  endByViewer(chatId: string, label: 'host' | 'guest'): ChatInfo {
    const chat = this.getChat(chatId);
    this.end(chat, `${label} human`, `Stopped by the ${label}'s human from the viewer.`);
    return this.info(this.getChat(chatId));
  }

  // ---------- housekeeping ----------

  /** Delete chats whose archive period has passed. Returns the number deleted. */
  sweep(): number {
    const cutoff = Date.now() - this.cfg.archiveDays * 86_400_000;
    const res = this.db.prepare(`DELETE FROM chats WHERE MAX(expires_at, COALESCE(ended_at, 0)) < ?`).run(cutoff);
    return Number(res.changes);
  }

  // ---------- internals ----------

  private findChat(chatId: string): ChatRow | undefined {
    if (!/^[0-9a-z]{26}$/.test(chatId)) return undefined;
    return this.db.prepare(`SELECT * FROM chats WHERE id = ?`).get(chatId) as unknown as ChatRow | undefined;
  }

  private getChat(chatId: string): ChatRow {
    const c = this.findChat(chatId);
    if (!c) throw new ChatError('NOT_FOUND', 'Chat not found.', 404);
    return c;
  }

  private status(c: ChatRow): Status {
    const s = c.status as Status;
    if ((s === 'waiting' || s === 'active' || s === 'locked') && Date.now() >= c.expires_at) return 'expired';
    return s;
  }

  private info(c: ChatRow): ChatInfo {
    const participants = this.db.prepare(`SELECT role, name FROM participants WHERE chat_id = ? ORDER BY id`).all(c.id) as Array<{ role: Role; name: string }>;
    return {
      id: c.id,
      topic: c.topic,
      groundRules: c.ground_rules,
      status: this.status(c),
      createdAt: iso(c.created_at),
      expiresAt: iso(c.expires_at),
      participants: participants.map((x) => ({ role: x.role, name: x.name })),
      messageCount: this.textCount(c.id),
      maxMessages: c.max_messages,
      endedBy: c.ended_by,
      endSummary: c.end_summary,
    };
  }

  private end(chat: ChatRow, by: string, summary: string) {
    const status = this.status(chat);
    if (!isLive(status) && status !== 'locked') return; // already ended/expired
    this.db.prepare(`UPDATE chats SET status = 'ended', ended_at = ?, ended_by = ?, end_summary = ? WHERE id = ?`).run(Date.now(), by, summary, chat.id);
    this.addMessage(chat.id, 'system', by, 'end', `Chat ended by ${by}. ${summary}`);
  }

  private addMessage(chatId: string, sender: string, senderName: string, kind: string, body: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE chat_id = ?`).get(chatId) as { next: number };
    this.db.prepare(`INSERT INTO messages (chat_id, seq, sender, sender_name, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(chatId, row.next, sender, senderName, kind, body, Date.now());
    this.notify(chatId);
    return row.next;
  }

  private messagesAfter(chatId: string, afterSeq: number): Message[] {
    const rows = this.db.prepare(`SELECT seq, sender, sender_name, kind, body, created_at FROM messages WHERE chat_id = ? AND seq > ? ORDER BY seq`).all(chatId, afterSeq) as unknown as MessageRow[];
    return rows.map((r) => ({ seq: r.seq, from: r.sender as Message['from'], name: r.sender_name, kind: r.kind as Message['kind'], text: r.body, at: iso(r.created_at) }));
  }

  private cursor(p: Participant): number {
    return (this.db.prepare(`SELECT last_read_seq FROM participants WHERE id = ?`).get(p.id) as { last_read_seq: number }).last_read_seq;
  }

  private unread(p: Participant): Message[] {
    return this.messagesAfter(p.chatId, this.cursor(p)).filter((m) => m.from !== p.role);
  }

  private unreadCount(p: Participant): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND seq > ? AND sender != ?`).get(p.chatId, this.cursor(p), p.role) as { n: number };
    return row.n;
  }

  private markRead(p: Participant, seq: number) {
    this.db.prepare(`UPDATE participants SET last_read_seq = MAX(last_read_seq, ?) WHERE id = ?`).run(seq, p.id);
  }

  private textCount(chatId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND kind = 'text'`).get(chatId) as { n: number }).n;
  }

  private notify(chatId: string) {
    const set = this.waiters.get(chatId);
    if (!set) return;
    this.waiters.delete(chatId);
    for (const wake of set) wake();
  }

  private waitForChange(chatId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiters.get(chatId);
      if (!set) this.waiters.set(chatId, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        const s = this.waiters.get(chatId);
        if (s) {
          s.delete(done);
          if (s.size === 0) this.waiters.delete(chatId);
        }
        resolve();
      };
      const timer = setTimeout(done, Math.max(ms, 0));
      signal?.addEventListener('abort', done, { once: true });
      set.add(done);
    });
  }
}
