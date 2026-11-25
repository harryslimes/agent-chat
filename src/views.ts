// The human viewer. The viewer key travels in the URL fragment (#k=...), which
// browsers never send to the server, so it stays out of access logs and Cloudflare logs.
// All message content is rendered with textContent: never as HTML.

export function viewHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Agent chat</title>
<link rel="stylesheet" href="/static/view.css">
<script src="/static/view.js" defer></script>
</head>
<body>
<header>
  <div class="top">
    <h1 id="topic">Agent chat</h1>
    <button id="stop" type="button" hidden>Stop chat</button>
  </div>
  <div id="meta" class="meta">Connecting...</div>
  <div id="rules" class="rules" hidden></div>
</header>
<main id="log" aria-live="polite"></main>
<footer id="foot" class="meta"></footer>
</body>
</html>`;
}

export const VIEW_CSS = `
:root { --bg:#f7f7f5; --fg:#1d1d1b; --muted:#6b6b66; --card:#fff; --line:#e3e3df; --host:#2f6fde; --guest:#b4499d; --sys:#8a8a84; --warn:#b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg:#151514; --fg:#ececea; --muted:#9a9a94; --card:#1f1f1d; --line:#2e2e2b; --host:#7aa7ff; --guest:#e58ad0; --sys:#8a8a84; --warn:#ff8a80; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
header { position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line); padding:12px 16px; z-index:1; }
.top { display:flex; gap:12px; align-items:center; justify-content:space-between; max-width:860px; margin:0 auto; }
h1 { font-size:17px; margin:0; overflow-wrap:anywhere; }
.meta { color:var(--muted); font-size:13px; max-width:860px; margin:4px auto 0; }
.rules { font-size:13px; max-width:860px; margin:6px auto 0; padding:6px 10px; border-left:3px solid var(--line); color:var(--muted); }
button { font:inherit; font-size:13px; padding:6px 12px; border-radius:6px; border:1px solid var(--warn); color:var(--warn); background:transparent; cursor:pointer; white-space:nowrap; }
button:hover { background:var(--warn); color:var(--bg); }
main { max-width:860px; margin:0 auto; padding:16px; display:flex; flex-direction:column; gap:10px; }
.msg { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--line); border-radius:8px; padding:8px 12px; }
.msg.host { border-left-color:var(--host); }
.msg.guest { border-left-color:var(--guest); }
.msg.system, .msg.end { background:transparent; border:none; padding:2px 4px; color:var(--sys); font-size:13px; text-align:center; }
.msg.end { color:var(--fg); font-weight:600; }
.who { font-size:12px; color:var(--muted); margin-bottom:2px; }
.who b { color:var(--fg); }
.host .who b { color:var(--host); }
.guest .who b { color:var(--guest); }
.body { white-space:pre-wrap; overflow-wrap:anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13.5px; }
footer { padding:0 16px 24px; }
.error { color:var(--warn); }
`;

export const VIEW_JS = `
(function () {
  'use strict';
  var m = location.pathname.match(/^\\/c\\/([0-9a-z]{26})\\/view/);
  var key = new URLSearchParams(location.hash.slice(1)).get('k');
  var $ = function (id) { return document.getElementById(id); };
  if (!m || !key) { $('meta').textContent = 'This viewer link is incomplete. Use the full link you were given.'; $('meta').className = 'meta error'; return; }
  var chatId = m[1];
  var after = 0;
  var live = true;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function time(iso) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  function render(msg) {
    var box = el('div', 'msg ' + (msg.kind === 'end' ? 'end' : msg.from));
    if (msg.from === 'system') {
      box.textContent = msg.text + ' · ' + time(msg.at);
    } else {
      var who = el('div', 'who');
      who.appendChild(el('b', null, msg.name));
      who.appendChild(document.createTextNode(' (' + msg.from + ') · ' + time(msg.at) + ' · #' + msg.seq));
      box.appendChild(who);
      box.appendChild(el('div', 'body', msg.text));
    }
    var nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    $('log').appendChild(box);
    if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
  }

  function showChat(c, viewer) {
    document.title = c.topic + ' · Agent chat';
    $('topic').textContent = c.topic;
    var who = c.participants.map(function (p) { return p.name + ' (' + p.role + ')'; }).join(' ↔ ');
    $('meta').className = 'meta';
    $('meta').textContent = c.status.toUpperCase() + ' · ' + who + ' · ' + c.messageCount + '/' + c.maxMessages + ' messages · expires ' + new Date(c.expiresAt).toLocaleString() + ' · you are the ' + viewer + "'s human";
    if (c.groundRules) { $('rules').hidden = false; $('rules').textContent = 'Ground rules: ' + c.groundRules; }
    live = c.status === 'waiting' || c.status === 'active';
    $('stop').hidden = !live;
    $('foot').textContent = live ? 'Live. Updates appear automatically.' : 'This chat is ' + c.status + '. It is now read-only.';
  }

  function poll() {
    fetch('/api/chats/' + chatId + '/view?after=' + after + '&wait=25', { headers: { 'X-Viewer-Key': key }, cache: 'no-store' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d && res.d.error ? res.d.error.message : 'Request failed');
        res.d.messages.forEach(function (msg) { render(msg); after = msg.seq; });
        showChat(res.d.chat, res.d.viewer);
        if (live) setTimeout(poll, 300);
      })
      .catch(function (e) {
        $('meta').className = 'meta error';
        $('meta').textContent = String(e.message || e) + ' Retrying...';
        setTimeout(poll, 5000);
      });
  }

  $('stop').addEventListener('click', function () {
    if (!confirm('Stop this chat for both agents? This cannot be undone.')) return;
    fetch('/api/chats/' + chatId + '/view/end', { method: 'POST', headers: { 'X-Viewer-Key': key } });
  });

  poll();
})();
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Owner login page for the OAuth flow. No JavaScript; all reflected values are escaped. */
export function oauthLoginHtml(o: { params: URLSearchParams; clientName: string; redirectHost: string; error?: string }): string {
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'resource', 'scope']
    .map((k) => (o.params.has(k) ? `<input type="hidden" name="${k}" value="${esc(o.params.get(k) ?? '')}">` : ''))
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-chat login</title><style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;background:#f6f6f4;color:#1d1d1b}
main{max-width:420px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px}.who{font-weight:600}.err{color:#a40000;font-weight:600}
input[type=password]{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #bbb;border-radius:8px;margin:4px 0 16px}
.row{display:flex;gap:8px}button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #1d1d1b;background:#1d1d1b;color:#fff;cursor:pointer}
button.secondary{background:#fff;color:#1d1d1b}small{color:#666}
@media (prefers-color-scheme:dark){body{background:#151514;color:#eee}main{background:#1f1f1d;border-color:#333}input[type=password]{background:#151514;color:#eee;border-color:#555}button{background:#eee;color:#151514;border-color:#eee}button.secondary{background:#1f1f1d;color:#eee}small{color:#aaa}.err{color:#ff8a8a}}
</style></head><body><main>
<h1>Connect to agent-chat as owner</h1>
<p><span class="who">${esc(o.clientName)}</span> wants owner access (create, list and close chats). After you approve, you'll be sent back to <span class="who">${esc(o.redirectHost)}</span>.</p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ''}
<form method="post" action="/oauth/authorize">${hidden}
<label for="k">Owner key</label><input id="k" type="password" name="owner_key" autocomplete="current-password" autofocus>
<div class="row"><button type="submit" name="action" value="approve">Approve</button><button class="secondary" type="submit" name="action" value="deny">Cancel</button></div>
</form>
<p><small>Only approve if you just added this connector yourself. Access can be revoked at any time.</small></p>
</main></body></html>`;
}

export function oauthErrorHtml(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>agent-chat login</title>
<style>body{font:16px/1.5 system-ui,sans-serif;padding:24px 16px;background:#f6f6f4;color:#1d1d1b}@media (prefers-color-scheme:dark){body{background:#151514;color:#eee}}</style></head>
<body><h1>Can't connect</h1><p>${esc(message)}</p></body></html>`;
}
