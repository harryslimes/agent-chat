// All configuration comes from environment variables (see .env.example).

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export interface Config {
  port: number;
  host: string;
  /** Public base URL, e.g. https://chat.example.com (no trailing slash). */
  publicUrl: string;
  /** Owner API key: only requests carrying it can create/list/close chats. */
  ownerKey: string;
  dbPath: string;
  /** Trust CF-Connecting-IP / X-Forwarded-For for client IPs (set when behind Cloudflare). */
  trustProxy: boolean;
  defaultTtlHours: number;
  maxTtlHours: number;
  archiveDays: number;
  maxMessages: number;
  maxMessageBytes: number;
  maxJoinFailures: number;
  /** Per participant, messages per minute. */
  sendPerMinute: number;
  /** Per IP, join attempts per hour. */
  joinPerHour: number;
  /** Per IP, requests per minute across the whole service. */
  requestsPerMinute: number;
  maxWaitSeconds: number;
  /** Hosts allowed as OAuth redirect targets for the owner connector (claude.ai, Claude Code on localhost). */
  oauthRedirectHosts: string[];
}

export function loadConfig(): Config {
  const ownerKey = required('OWNER_KEY');
  if (ownerKey.length < 32) throw new Error('OWNER_KEY must be at least 32 characters (try: openssl rand -hex 32)');
  return {
    port: int('PORT', 8080),
    host: process.env.HOST ?? '0.0.0.0',
    publicUrl: required('PUBLIC_URL').replace(/\/+$/, ''),
    ownerKey,
    dbPath: process.env.DB_PATH ?? './data/agent-chat.db',
    trustProxy: process.env.TRUST_PROXY === 'true',
    defaultTtlHours: int('DEFAULT_TTL_HOURS', 24),
    maxTtlHours: int('MAX_TTL_HOURS', 168),
    archiveDays: int('ARCHIVE_DAYS', 30),
    maxMessages: int('MAX_MESSAGES', 200),
    maxMessageBytes: int('MAX_MESSAGE_BYTES', 8192),
    maxJoinFailures: int('MAX_JOIN_FAILURES', 5),
    sendPerMinute: int('SEND_PER_MINUTE', 20),
    joinPerHour: int('JOIN_PER_HOUR', 20),
    requestsPerMinute: int('REQUESTS_PER_MINUTE', 240),
    maxWaitSeconds: int('MAX_WAIT_SECONDS', 30),
    oauthRedirectHosts: (process.env.OAUTH_REDIRECT_HOSTS ?? 'claude.ai,claude.com,localhost,127.0.0.1')
      .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  };
}
