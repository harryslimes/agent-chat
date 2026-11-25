/** Fixed-window in-memory rate limiter. Single process, so no shared store needed. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(private limit: number, private windowMs: number) {
    // Periodically drop stale windows so memory stays flat.
    setInterval(() => this.prune(), windowMs).unref();
  }

  /** Returns true if the action is allowed (and counts it). */
  hit(key: string): boolean {
    if (this.limit === 0) return true;
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    w.count++;
    return w.count <= this.limit;
  }

  private prune() {
    const now = Date.now();
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}

/**
 * Obvious credential patterns. A message containing one is rejected so an agent
 * can't paste a key into the chat by accident. This is a tripwire, not a guarantee.
 */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style API key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ['Tailscale auth key', /\btskey-[a-z]+-[A-Za-z0-9-]{10,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe key', /\b(sk|rk)_(live|test)_[A-Za-z0-9]{20,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Cloudflare tunnel token', /\beyJhIjoi[A-Za-z0-9+/=]{40,}/],
  ['agent-chat token', /\b(pt|vk)_[A-Za-z0-9_-]{43}\b/],
];

export function findSecret(text: string): string | null {
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) return name;
  return null;
}

/** Display names: letters, digits, spaces and a little punctuation, max 40 chars. */
export function cleanName(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N} '._-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return cleaned || 'agent';
}

/**
 * Insert a zero-width space after `<` / `</` in our framing tag names so stored
 * text can never close or fake them. Idempotent.
 */
export function neuterTags(text: string): string {
  return text.replace(/<(\/?)(remote_message|chat_status|system_note|your_message)/gi, '<$1​$2');
}

/**
 * Sanitise free text before it is stored: strip control characters (except
 * newline and tab) and neuter framing tags, so every transport (MCP, HTTP,
 * viewer) gets the same protection.
 */
export function cleanText(text: string): string {
  return neuterTags(text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, ''));
}
