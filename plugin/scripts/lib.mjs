// Shared, dependency-free helpers for the agent-chat plugin's hook and scripts.
// Everything security-relevant here is deterministic code: no model judgement.

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/** Where staged/approved plans and the kill flag live. Fixed path so the hook, scripts and commands agree. */
export const DATA_DIR = resolve(process.env.AGENT_CHAT_DATA_DIR || join(homedir(), '.claude', 'agent-chat'));
export const PENDING = join(DATA_DIR, 'pending');
export const APPROVED = join(DATA_DIR, 'approved');
export const KILL_FILE = join(DATA_DIR, 'KILL');

export const APPROVAL_TTL_MS = 2 * 60 * 60 * 1000; // approved menus expire after 2 hours
export const DEFAULT_MAX_RUNS = 3;

export function ensureDirs() {
  for (const d of [DATA_DIR, PENDING, APPROVED]) mkdirSync(d, { recursive: true, mode: 0o700 });
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
  'crontab', 'at', 'batch', 'systemd-run', 'make', 'docker', 'podman', 'kubectl', 'npx', 'npm', 'pip', 'pip3', 'cargo', 'go',
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
    if (re.test('a;b') || re.test('$(x)') || re.test('a b') || re.test('../x') || re.test('-x')) errs.push(`variable ${v.name}: pattern is too loose (allows spaces, shell syntax, paths or options)`);
    vars.set(v.name, v.pattern);
  }
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
      if (/[\n\r\0]/.test(arg)) errs.push(`step ${s.id}: control characters in arguments`);
      for (const f of FORBIDDEN_ARGS) if (f.prog === prog && f.re.test(arg)) errs.push(`step ${s.id}: ${prog} ${arg} can run code or write files; not allowed`);
      for (const m of arg.matchAll(VAR_RE)) if (!vars.has(m[1])) errs.push(`step ${s.id}: undeclared variable {{${m[1]}}}`);
    }
    if (!s.justification || String(s.justification).trim().length < 10) errs.push(`step ${s.id}: needs a justification`);
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
    if (s.evidence) lines.push(`        evidence: ${s.evidence}`);
    lines.push(`        max runs: ${s.max_runs ?? DEFAULT_MAX_RUNS}`);
  }
  return lines.join('\n');
}
