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

// ---------- forged framing ----------
//
// Remote text must never be able to imitate the structure an agent's harness uses:
// our own wrapper tags, harness tags (system reminders, tool calls/results) or chat
// turn markers. We neuter them by inserting a zero-width space (invisible to humans,
// but it breaks the token sequence) and record what was attempted so the sender can
// be flagged. Everything here is idempotent: neutered text never matches again.

const ZWSP = '​';

/**
 * Tag names that look like agent/harness framing (case-insensitive). Each may carry a
 * `-`/`_`/`:` suffix (system-reminder, remote_message_x7k2, antml:invoke) but must then
 * end the name, so ordinary tags like <systemd> or <toolbar> are left alone.
 */
const FRAMING_NAMES = [
  'remote_message', 'your_message', 'chat_status', 'system_note',
  'system', 'function_calls', 'function_results', 'function', 'antml', 'tool_use', 'tool_result', 'tool',
  'invoke', 'parameter', 'human', 'assistant', 'untrusted', 'instructions',
];

/** `<` and visually similar brackets: fullwidth, small, angle, mathematical, single guillemet, Canadian syllabics. */
const OPENERS = '<＜﹤〈〈⟨‹ᐸ';
const CLOSERS = '>＞﹥〉〉⟩›ᐳ';
const LOOKALIKE_OPENERS = OPENERS.slice(1);
const SLASHES = '/／∕⁄';
const NAME_RE = `(?:${FRAMING_NAMES.join('|')})(?:[-_:][\\w:-]*)?(?=[\\s${CLOSERS}${SLASHES}]|$)`;

// `<`, optional whitespace and slash, then a framing name. A zero-width space after
// the slash (already neutered) stops the match, which keeps this idempotent.
const TAG_RE = new RegExp(`([${OPENERS}])([ \\t]*[${SLASHES}]?[ \\t]*)(?=${NAME_RE})`, 'giu');
// Chat-transcript turn markers at the start of a line.
const TURN_RE = /^([ \t]*)(Human|Assistant|System)([ \t]*:)/gim;
// Invisible Unicode "tag" characters (U+E0000–E007F), usable to smuggle hidden ASCII text.
const TAG_CHARS_RE = /[\u{E0000}-\u{E007F}]/gu;

export type FramingFlag = 'framing-tag' | 'lookalike-brackets' | 'turn-marker' | 'hidden-tag-chars';

/** What kinds of forged framing a piece of raw text contains (empty when clean). */
export function detectFraming(text: string): FramingFlag[] {
  const flags = new Set<FramingFlag>();
  for (const m of text.matchAll(TAG_RE)) {
    flags.add('framing-tag');
    if (LOOKALIKE_OPENERS.includes(m[1])) flags.add('lookalike-brackets');
  }
  if (new RegExp(TURN_RE.source, 'im').test(text)) flags.add('turn-marker');
  if (new RegExp(TAG_CHARS_RE.source, 'u').test(text)) flags.add('hidden-tag-chars');
  return [...flags];
}

/**
 * Neuter anything that could close or fake framing: tags (including look-alike
 * brackets, folded to `<`) get a zero-width space after the `<` / `</`, and turn
 * markers get one before the colon. Idempotent; safe to run on every delivery.
 */
export function neuterFraming(text: string): string {
  return text
    .replace(TAG_RE, (_m, _open: string, slash: string) => `<${slash.replace(/[ \t]/g, '').replace(/./u, '/')}${ZWSP}`)
    .replace(TURN_RE, `$1$2${ZWSP}$3`);
}

/**
 * Sanitise free text before it is stored: strip control characters (except
 * newline and tab), bidi overrides and invisible tag characters, then neuter
 * framing, so every transport (MCP, HTTP, viewer) gets the same protection.
 */
export function cleanText(text: string): string {
  return neuterFraming(text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '').replace(TAG_CHARS_RE, ''));
}
