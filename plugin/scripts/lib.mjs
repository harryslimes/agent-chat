// Shared, dependency-free helpers for the agent-chat plugin's hook and scripts.
// Everything security-relevant here is deterministic code: no model judgement.

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, join, resolve } from 'node:path';

/** Where staged/approved plans and the kill flag live. Fixed path so the hook, scripts and commands agree. */
export const DATA_DIR = resolve(process.env.AGENT_CHAT_DATA_DIR || join(homedir(), '.claude', 'agent-chat'));
export const PENDING = join(DATA_DIR, 'pending');
export const APPROVED = join(DATA_DIR, 'approved');
export const KILL_FILE = join(DATA_DIR, 'KILL');
export const RESULTS = join(DATA_DIR, 'results');
export const SHARE_BUDGET = 12000; // total characters of command output sent back to the other agent

/**
 * Security level (env AGENT_CHAT_SECURITY):
 *  - standard (default): one Allow prompt approves a plan; outputs marked share go back to
 *    the other agent automatically after code filtering.
 *  - max: the same, plus a second Allow prompt before any results are sent, after the user
 *    has seen the filtered text.
 */
export const SECURITY = String(process.env.AGENT_CHAT_SECURITY || 'standard').toLowerCase() === 'max' ? 'max' : 'standard';

export const APPROVAL_TTL_MS = 2 * 60 * 60 * 1000; // approved menus expire after 2 hours
export const DEFAULT_MAX_RUNS = 3;

export function ensureDirs() {
  for (const d of [DATA_DIR, PENDING, APPROVED, RESULTS]) mkdirSync(d, { recursive: true, mode: 0o700 });
}

/** Stable JSON (sorted keys) so the same plan always hashes the same. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---------- plan validation ----------

/** Programs that run arbitrary code or spawn shells: never allowed on a menu (GTFOBins-style, not exhaustive). */
const FORBIDDEN_PROGRAMS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'busybox',
  'python', 'python2', 'python3', 'perl', 'ruby', 'node', 'nodejs', 'deno', 'bun', 'php', 'lua', 'tclsh', 'wish', 'Rscript',
  'awk', 'gawk', 'mawk', 'nawk', 'sed', 'xargs', 'env', 'command', 'builtin', 'exec', 'eval', 'source', '.',
  'sudo', 'su', 'doas', 'pkexec', 'runuser', 'nohup', 'setsid', 'timeout', 'nice', 'ionice', 'stdbuf', 'chroot', 'unshare', 'nsenter',
  'strace', 'ltrace', 'gdb', 'lldb', 'script', 'expect', 'watch', 'flock', 'parallel',
  'less', 'more', 'most', 'man', 'vi', 'vim', 'nvim', 'view', 'emacs', 'nano', 'pico', 'ed', 'ex', 'joe',
  'time', 'chrt', 'taskset', 'firejail', 'bwrap', 'proot', 'fakeroot', 'crontab', 'at', 'batch', 'systemd-run', 'make', 'docker', 'podman', 'kubectl', 'npx', 'npm', 'pip', 'pip3', 'cargo', 'go',
]);

/** Arguments that turn otherwise-safe tools into code execution. */
const FORBIDDEN_ARGS = [
  { prog: 'find', re: /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/ },
  { prog: 'tar', re: /^(--checkpoint-action|--to-command|--use-compress-program|--info-script|--new-volume-script|-I|-F)/ },
  { prog: 'zip', re: /^(-T|-TT|--unzip-command)/ },
  { prog: 'git', re: /^(-c|--config-env|--exec-path|--upload-pack|--receive-pack|-u|config|submodule|filter-branch|difftool|mergetool|bisect|rebase|commit|am|apply|hook)$|^--(upload-pack|receive-pack|exec)=/ },
  { prog: 'ssh', re: /^-(o|F|J|w|L|R|D)|ProxyCommand|LocalCommand|PermitLocalCommand/i },
  { prog: 'scp', re: /^-(S|o|F)/ },
  { prog: 'rsync', re: /^(-e|--rsh|--rsync-path)/ },
  { prog: 'curl', re: /^(-K|--config|-o|--output|-O|--remote-name|-T|--upload-file|-d@|--data-binary)/ },
  { prog: 'wget', re: /^(-O|--output-document|-e|--execute|--post-file|-i)/ },
  { prog: 'openssl', re: /^(-engine|engine)$/ },
  { prog: 'tcpdump', re: /^(-z|-w)$/ },
];

/** Free text in a plan is written by the talker under the other agent's influence: keep it short and plain. */
function textErr(errs, where, v) {
  if (typeof v !== 'string') return errs.push(`${where} must be text`);
  if (v.length > 400) errs.push(`${where} is longer than 400 characters`);
  if (/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\u200b-\u200f]/.test(v)) errs.push(`${where} has control or invisible characters`);
}

const VAR_RE = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g;

/** Validate a plan; returns a list of problems (empty = valid). */
export function validatePlan(plan) {
  const errs = [];
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps) || !plan.steps.length) return ['plan has no steps'];
  const vars = new Map();
  for (const v of plan.variables || []) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(v.name || '')) errs.push(`bad variable name ${JSON.stringify(v.name)}`);
    let re;
    try {
      re = new RegExp(v.pattern);
    } catch {
      errs.push(`variable ${v.name}: invalid regex`);
      continue;
    }
    if (!/^\^/.test(v.pattern) || !/\$$/.test(v.pattern)) errs.push(`variable ${v.name}: pattern must be anchored with ^...$`);
    if (['a;b', '$(x)', 'a b', '../x', '-x', '/etc/passwd', '..', '~/x', '/'].some((p) => re.test(p))) errs.push(`variable ${v.name}: pattern is too loose (allows spaces, shell syntax, paths or options)`);
    vars.set(v.name, v.pattern);
  }
  if (plan.goal !== undefined) textErr(errs, 'goal', plan.goal);
  for (const v of plan.variables || []) if (v.description !== undefined) textErr(errs, `variable ${v.name} description`, v.description);
  if (plan.steps.length > 25) errs.push('plan has more than 25 steps');
  const ids = new Set();
  for (const s of plan.steps) {
    if (!/^[a-z0-9_-]{1,32}$/.test(s.id || '')) errs.push(`bad step id ${JSON.stringify(s.id)}`);
    if (ids.has(s.id)) errs.push(`duplicate step id ${s.id}`);
    ids.add(s.id);
    if (!Array.isArray(s.argv) || !s.argv.length || s.argv.some((a) => typeof a !== 'string')) {
      errs.push(`step ${s.id}: argv must be a non-empty array of strings`);
      continue;
    }
    const prog = basename(s.argv[0]);
    if (FORBIDDEN_PROGRAMS.has(prog)) errs.push(`step ${s.id}: ${prog} can run arbitrary code; not allowed on a menu`);
    if (VAR_RE.test(s.argv[0])) errs.push(`step ${s.id}: the program itself can't be a variable`);
    VAR_RE.lastIndex = 0;
    for (const arg of s.argv) {
      if (/[^\x20-\x7e]/.test(arg)) errs.push(`step ${s.id}: arguments must be printable ASCII (no control, escape or bidi characters)`);
      if (arg.length > 300) errs.push(`step ${s.id}: argument too long`);
      for (const f of FORBIDDEN_ARGS) if (f.prog === prog && f.re.test(arg)) errs.push(`step ${s.id}: ${prog} ${arg} can run code or write files; not allowed`);
      if (/[;&|<>`$(){}\\*?~!#]/.test(arg.replace(VAR_RE, ''))) errs.push(`step ${s.id}: ${JSON.stringify(arg)} contains shell characters (; & | < > ` + '`' + ` $ ( ) { } \\ * ? ~ ! #) that the guard refuses, so it could never run. Rewrite without them`);
      VAR_RE.lastIndex = 0;
      for (const m of arg.matchAll(VAR_RE)) if (!vars.has(m[1])) errs.push(`step ${s.id}: undeclared variable {{${m[1]}}}`);
    }
    if (!s.justification || String(s.justification).trim().length < 10) errs.push(`step ${s.id}: needs a justification`);
    if (s.share !== undefined && typeof s.share !== 'boolean') errs.push(`step ${s.id}: share must be true or false`);
    if (s.max_runs !== undefined && !(Number.isInteger(s.max_runs) && s.max_runs >= 1 && s.max_runs <= 10)) errs.push(`step ${s.id}: max_runs must be a whole number from 1 to 10`);
    for (const f of ['justification', 'when', 'evidence']) if (s[f] !== undefined) textErr(errs, `step ${s.id} ${f}`, s[f]);
  }
  return errs;
}

// ---------- matching a Bash command against an approved menu ----------

/**
 * Split a command into argv WITHOUT a shell. Returns null for anything with shell
 * syntax (pipes, redirects, substitution, globbing, chaining, env prefixes), so such a
 * command can never match a menu entry.
 */
export function splitCommand(cmd) {
  if (typeof cmd !== 'string' || /[;&|<>`$(){}\n\r\\*?~!#]/.test(cmd)) return null;
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === ' ' || ch === '\t') {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started) out.push(cur);
  if (!out.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0])) return null;
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unanchor = (p) => p.replace(/^\^/, '').replace(/\$$/, '');

/** Does argv match a step template exactly (variables matched against their patterns)? */
export function matchStep(argv, step, variables) {
  if (argv.length !== step.argv.length) return false;
  const pats = new Map((variables || []).map((v) => [v.name, v.pattern]));
  return step.argv.every((tpl, i) => {
    let src = '';
    let last = 0;
    for (const m of tpl.matchAll(VAR_RE)) {
      src += escapeRe(tpl.slice(last, m.index)) + `(?:${unanchor(pats.get(m[1]) ?? '(?!)')})`;
      last = m.index + m[0].length;
    }
    src += escapeRe(tpl.slice(last));
    return new RegExp(`^${src}$`).test(argv[i]);
  });
}

// ---------- plan files ----------

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Approved, unexpired plans whose stored hash still matches their content. */
export function activePlans(now = Date.now()) {
  let names = [];
  try {
    names = readdirSync(APPROVED).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const plans = [];
  for (const n of names) {
    try {
      const rec = readJson(join(APPROVED, n));
      if (rec.expires_at < now) continue;
      if (sha256(canonical(rec.plan)) !== rec.hash || !n.startsWith(rec.hash.slice(0, 12))) continue; // tampered
      if (validatePlan(rec.plan).length) continue; // re-check rules at use time
      plans.push({ file: join(APPROVED, n), rec });
    } catch {
      /* unreadable: ignore */
    }
  }
  return plans;
}

/**
 * Staged (not yet approved) plans, still fresh, whose stored hash matches their content.
 * The guard turns a matching executor command into a native permission prompt ("ask"),
 * so the user approves with Claude Code's own Allow button, which no model can press.
 */
export function stagedPlans(now = Date.now()) {
  let names = [];
  try {
    names = readdirSync(PENDING).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const plans = [];
  for (const n of names) {
    try {
      const rec = readJson(join(PENDING, n));
      if (!(rec.staged_at + APPROVAL_TTL_MS >= now)) continue;
      if (sha256(canonical(rec.plan)) !== rec.hash || !n.startsWith(rec.hash.slice(0, 12))) continue;
      if (validatePlan(rec.plan).length) continue;
      plans.push({ file: join(PENDING, n), rec });
    } catch {
      /* unreadable: ignore */
    }
  }
  return plans;
}

/** Human-readable menu, rendered by code (not a model) so what you approve is exactly what runs. */
export function renderPlan(plan, id) {
  const lines = [];
  lines.push(`Plan ${id}${plan.goal ? `: ${plan.goal}` : ''}`);
  if (plan.variables?.length) {
    lines.push('', 'Variables (filled at run time, must match the pattern):');
    for (const v of plan.variables) lines.push(`  {{${v.name}}}  ${v.pattern}${v.description ? `  (${v.description})` : ''}`);
  }
  lines.push('', 'Commands (exact; nothing else will be allowed):');
  for (const s of plan.steps) {
    lines.push(`  [${s.id}] ${s.argv.map((a) => (/[\s'"]/.test(a) || a === '' ? JSON.stringify(a) : a)).join(' ')}`);
    if (s.when) lines.push(`        when: ${s.when}`);
    lines.push(`        why:  ${s.justification}`);
    lines.push(`        output to the other agent: ${s.share ? 'yes (filtered)' : 'no'}`);
    if (s.evidence) lines.push(`        evidence: ${s.evidence}`);
    lines.push(`        max runs: ${s.max_runs ?? DEFAULT_MAX_RUNS}`);
  }
  return lines.join('\n');
}

const fmtArgv = (argv) => argv.map((a) => (/[\s'"]/.test(a) || a === '' ? JSON.stringify(a) : a)).join(' ');

/** Lines the native permission prompt shows before it truncates. */
export const PROMPT_MAX_LINES = 10;

/**
 * Short form for the native permission prompt: one line per command, plus variable
 * patterns. Returns null if it can't fit, so the caller can refuse the prompt route rather
 * than have steps approved unseen.
 */
export function renderPlanCompact(plan, id) {
  const home = homedir();
  const lines = [`agent-chat plan ${id}: Allow runs these ${plan.steps.length} commands and nothing else (2 hours).`];
  plan.steps.forEach((s, i) => {
    const runs = (s.max_runs ?? DEFAULT_MAX_RUNS) > 1 ? ` (x${s.max_runs ?? DEFAULT_MAX_RUNS})` : '';
    lines.push(`${i + 1}. ${fmtArgv(s.argv).split(home).join('~')}${runs}${s.share ? '  [output shared]' : ''}`);
  });
  for (const v of plan.variables || []) lines.push(`   {{${v.name}}} must match ${v.pattern}`);
  return lines.length <= PROMPT_MAX_LINES ? lines.join('\n') : null;
}

/** Only one plan waits for approval at a time, so a prompt can never show a stale plan. */
export function clearPending(exceptId) {
  let names = [];
  try {
    names = readdirSync(PENDING);
  } catch {
    return;
  }
  for (const n of names) if (!exceptId || !n.startsWith(exceptId)) rmSync(join(PENDING, n), { force: true });
}

/** Recorded outputs belong to one approval: cleared whenever a plan is (re)approved or stopped. */
export function clearResults(id) {
  rmSync(id ? join(RESULTS, `${id}.json`) : RESULTS, { force: true, recursive: !id });
}

/** Only one plan is approved at a time: approving a new one revokes the rest and their results. */
export function revokeApprovedExcept(id) {
  let names = [];
  try {
    names = readdirSync(APPROVED);
  } catch {
    return;
  }
  for (const n of names) {
    if (n.startsWith(id)) continue;
    rmSync(join(APPROVED, n), { force: true });
    clearResults(n.slice(0, 12));
  }
}

/** Start a fresh results log for a newly approved plan, listing its steps so unrun ones can be reported. */
export function startResults(id, plan) {
  ensureDirs();
  writeJson(join(RESULTS, `${id}.json`), { id, planned: plan.steps.map((s) => ({ id: s.id, share: s.share === true })), steps: [] });
}

/** One staged plan by id, if fresh and untampered. */
export function stagedPlan(id, now = Date.now()) {
  return stagedPlans(now).find(({ rec }) => rec.hash.startsWith(id)) || null;
}

// ---------- filtering command output before it goes to the other agent ----------

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\s*[A-Za-z0-9+/=:,-]{1,100}(?![A-Za-z0-9+/=]))*(?:\s*-----END [A-Z ]*PRIVATE KEY-----)?/g, // the key's base64 lines, terminated or not
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\btskey-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:pt|vk)_[A-Za-z0-9_-]{20,}/g,
  /\bssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/=]{40,}/g,
  /\becdsa-sha2-[a-z0-9]+\s+[A-Za-z0-9+/=]{40,}/g,
];
// Labelled values: key = value, key: value, "key": "value", Authorization: Bearer xyz, cookies.
const LABELLED = /((?:api[_-]?key|secret|token|password|passwd|pwd|owner[_-]?key|auth(?:orization)?|cookie|session|credential|private[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?)[^\s"',;}]{4,}/gi;
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Default hostnames that identify nobody, and would wreck ordinary text if blanked.
const GENERIC_HOSTS = new Set(['localhost', 'fedora', 'ubuntu', 'debian', 'archlinux', 'raspberrypi', 'kali', 'linux', 'pop-os', 'mint']);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Deterministic filter: secrets, home path, username, this machine's and the relay's hostnames, emails. */
export function redact(text, { user, host, extraHosts = [] } = {}) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  out = out.replace(LABELLED, '$1[redacted]');
  out = out.replace(URL_CREDS, '$1[redacted]@');
  out = out.replace(EMAIL, '[email]');
  out = out.split(homedir()).join('~');
  for (const h of [host, ...extraHosts].filter((h) => h && h.length > 2 && !GENERIC_HOSTS.has(h.toLowerCase()))) out = out.replace(new RegExp(escRe(h), 'gi'), '[host]');
  if (user && user.length > 2) out = out.replace(new RegExp(escRe(user), 'gi'), '[user]');
  return out;
}

export function defaultRedactOpts() {
  let relayHost;
  try {
    relayHost = process.env.AGENT_CHAT_URL ? new URL(process.env.AGENT_CHAT_URL).hostname : undefined;
  } catch {}
  return { user: userInfo().username, host: hostname(), extraHosts: [relayHost] };
}

/** Fit outputs into the budget: smallest first, so whatever they don't use goes to the bigger ones. */
export function fitOutputs(items, budget = SHARE_BUDGET) {
  const order = items.map((it, i) => i).sort((a, b) => items[a].text.length - items[b].text.length);
  const out = items.slice();
  let left = budget;
  order.forEach((idx, k) => {
    const it = items[idx];
    const share = Math.floor(left / (order.length - k));
    const text = it.text.length > share ? `${it.text.slice(0, share)}\n[truncated ${it.text.length - share} characters]` : it.text;
    left -= Math.min(it.text.length, share);
    out[idx] = { ...it, text };
  });
  return out;
}

/** The exact text sent back to the other agent for an approved plan's results, or null if none ran. */
export function buildShareText(id, opts = defaultRedactOpts()) {
  let log;
  try {
    log = readJson(join(RESULTS, `${id}.json`));
  } catch {
    return null;
  }
  const fmt = (argv) => redact(argv.join(' '), opts);
  const shared = log.steps.filter((s) => s.share).map((s) => ({ ...s, text: redact(s.output, opts) }));
  const withheld = [...new Set(log.steps.filter((s) => !s.share).map((s) => s.id))];
  const ran = new Set(log.steps.map((s) => s.id));
  const notRun = (log.planned || []).filter((p) => !ran.has(p.id)).map((p) => p.id);
  const out = [`Results of the approved plan ${id} (filtered by code for secrets, paths, usernames, hostnames and emails; size-capped):`];
  for (const s of fitOutputs(shared)) out.push('', `$ ${fmt(s.argv)}  [${s.id}]${s.exit ? ` (exit ${s.exit})` : ''}`, s.text.trimEnd() || '(no output)');
  if (withheld.length) out.push('', `Ran but not shared (for the user only): ${withheld.join(', ')}`);
  if (notRun.length) out.push('', `Not run (blocked by the guard, skipped by a branch condition, or the run stopped): ${notRun.join(', ')}`);
  return out.join('\n');
}
