import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { ChatError, type ChatService } from './chat.js';
import type { Config } from './config.js';
import { RateLimiter } from './guards.js';
import { isOwnerRequest } from './mcp.js';
import { OAuthError, type OAuthService, OWNER_MCP_PATH } from './oauth.js';
import { agentInstructions, inviteText, TRUST_NOTE } from './text.js';
import { oauthErrorHtml, oauthLoginHtml, VIEW_CSS, VIEW_JS, viewHtml } from './views.js';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const HTML_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function withHeaders(res: Response, extra: Record<string, string> = {}): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) if (!headers.has(k)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

const text = (body: string, contentType = 'text/plain; charset=utf-8', status = 200, cache = 'no-store') =>
  new Response(body, { status, headers: { 'Content-Type': contentType, 'Cache-Control': cache } });

const errorJson = (code: string, message: string, status: number) => json({ error: { code, message } }, status);

function bearer(req: Request): string {
  const m = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    throw new ChatError('BAD_JSON', 'Request body must be a JSON object.');
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Read a form-encoded or JSON body as URLSearchParams (OAuth endpoints accept both). */
async function formParams(req: Request): Promise<URLSearchParams> {
  const raw = await req.text();
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(o).filter(([, v]) => typeof v === 'string') as Array<[string, string]>);
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(raw);
}

const oauthJsonError = (e: OAuthError) => json({ error: e.error, error_description: e.description }, e.httpStatus);

/** The login page posts a form and then redirects, so form-action must allow us and the client's redirect origin. */
const loginCsp = (redirectOrigin: string) =>
  `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; base-uri 'none'; frame-ancestors 'none'`;

export interface AppDeps {
  cfg: Config;
  chats: ChatService;
  mcp: McpHttpHandler;
  oauth: OAuthService;
}

export function createApp({ cfg, chats, mcp, oauth }: AppDeps) {
  const isOwner = (req: Request) => isOwnerRequest(req, cfg, oauth);
  const publicOrigin = new URL(cfg.publicUrl).origin;
  const requestLimiter = new RateLimiter(cfg.requestsPerMinute, 60_000);
  const joinLimiter = new RateLimiter(cfg.joinPerHour, 3_600_000);

  async function route(req: Request, ip: string): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === '/healthz') return text('ok');

    if (!requestLimiter.hit(ip)) return errorJson('RATE_LIMITED', 'Too many requests. Slow down.', 429);

    // Browsers always send Origin on cross-site requests; reject anything not from us (MCP spec requires 403).
    const origin = req.headers.get('origin');
    if (origin && origin !== publicOrigin) return errorJson('BAD_ORIGIN', 'Origin not allowed.', 403);

    if (path === '/mcp') return mcp.fetch(req);
    // Owner connector endpoint: same MCP server, but auth is required so OAuth clients
    // (claude.ai) discover the login flow from the 401. /mcp stays open for guests.
    if (path === OWNER_MCP_PATH) {
      if (!isOwner(req)) {
        return withHeaders(errorJson('UNAUTHORIZED', 'Owner login required.', 401), {
          'WWW-Authenticate': `Bearer resource_metadata="${oauth.resourceMetadataUrl}"`,
        });
      }
      return mcp.fetch(req);
    }

    // ---- OAuth (owner connector) ----
    if (method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === `/.well-known/oauth-protected-resource${OWNER_MCP_PATH}`)) {
      return json(oauth.protectedResourceMetadata());
    }
    if (method === 'GET' && (path.startsWith('/.well-known/oauth-authorization-server') || path.startsWith('/.well-known/openid-configuration'))) {
      return json(oauth.authServerMetadata());
    }
    if (path.startsWith('/oauth/')) return oauthRoute(req, path, method, ip);

    if (method === 'GET' && path === '/') {
      return text('agent-chat relay. If you were sent an invite, open the chat URL it contains.\n');
    }
    if (method === 'GET' && path === '/static/view.js') return text(VIEW_JS, 'text/javascript; charset=utf-8', 200, 'public, max-age=300');
    if (method === 'GET' && path === '/static/view.css') return text(VIEW_CSS, 'text/css; charset=utf-8', 200, 'public, max-age=300');

    let m = path.match(/^\/c\/([0-9a-z]{26})\/?$/);
    // Instructions are generic and served for any well-formed ID, so this reveals nothing.
    if (method === 'GET' && m) return text(agentInstructions(cfg.publicUrl, m[1]), 'text/markdown; charset=utf-8');
    m = path.match(/^\/c\/([0-9a-z]{26})\/view\/?$/);
    if (method === 'GET' && m) return withHeaders(text(viewHtml(), 'text/html; charset=utf-8'), { 'Content-Security-Policy': HTML_CSP });

    // ---- owner API ----
    if (path === '/api/oauth/revoke' && method === 'POST') {
      if (!isOwner(req)) return errorJson('UNAUTHORIZED', 'Owner key required.', 401);
      return json(oauth.revokeAll());
    }
    if (path === '/api/chats' || /^\/api\/chats\/[0-9a-z]{26}\/close$/.test(path)) {
      if (!isOwner(req)) return errorJson('UNAUTHORIZED', 'Owner key required.', 401);
      if (method === 'POST' && path === '/api/chats') {
        const b = await body(req);
        const guestLabel = str(b.guest_label) || 'your friend';
        const created = chats.createChat({ topic: str(b.topic), groundRules: str(b.ground_rules), hostName: str(b.host_name) || undefined, ttlHours: num(b.ttl_hours), maxMessages: num(b.max_messages) });
        return json(
          {
            chat_id: created.chatId,
            chat_url: `${cfg.publicUrl}/c/${created.chatId}`,
            join_code: created.joinCode,
            host_token: created.hostToken,
            host_viewer_url: `${cfg.publicUrl}/c/${created.chatId}/view#k=${created.hostViewerKey}`,
            expires_at: created.expiresAt,
            invite_text: inviteText(cfg.publicUrl, created, str(b.topic), guestLabel),
          },
          201,
        );
      }
      if (method === 'GET' && path === '/api/chats') return json({ chats: chats.listChats() });
      const closeId = path.split('/')[3];
      if (method === 'POST') return json({ chat: chats.closeChat(closeId) });
      return errorJson('METHOD', 'Method not allowed.', 405);
    }

    // ---- participant + viewer API ----
    m = path.match(/^\/api\/chats\/([0-9a-z]{26})\/(join|messages|history|end|view|view\/end)$/);
    if (!m) return errorJson('NOT_FOUND', 'Not found.', 404);
    const [, chatId, action] = m;

    if (action === 'join' && method === 'POST') {
      if (!joinLimiter.hit(ip)) return errorJson('RATE_LIMITED', 'Too many join attempts from your address. Try later.', 429);
      const b = await body(req);
      const { token, participant, chat } = chats.join(chatId, str(b.code), str(b.name) || 'guest agent');
      const { messages } = chats.history(participant);
      return json({ token, you: { role: participant.role, name: participant.name }, chat, messages, notice: TRUST_NOTE });
    }

    if (action === 'view' || action === 'view/end') {
      const label = chats.authViewer(chatId, req.headers.get('x-viewer-key') ?? '');
      if (action === 'view' && method === 'GET') {
        const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
        const wait = Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0);
        const r = await chats.view(chatId, after, wait, req.signal);
        return json({ viewer: label, ...r });
      }
      if (action === 'view/end' && method === 'POST') return json({ chat: chats.endByViewer(chatId, label) });
      return errorJson('METHOD', 'Method not allowed.', 405);
    }

    const p = chats.authParticipant(bearer(req), chatId);
    if (action === 'messages' && method === 'GET') {
      const wait = Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0);
      const r = await chats.read(p, wait, req.signal);
      return json({ ...r, you: { role: p.role, name: p.name }, notice: r.messages.length ? TRUST_NOTE : undefined });
    }
    if (action === 'messages' && method === 'POST') {
      const b = await body(req);
      return json(chats.send(p, str(b.text)), 201);
    }
    if (action === 'history' && method === 'GET') return json({ ...chats.history(p), you: { role: p.role, name: p.name }, notice: TRUST_NOTE });
    if (action === 'end' && method === 'POST') {
      const b = await body(req);
      return json({ chat: chats.endByParticipant(p, str(b.summary)) });
    }
    return errorJson('METHOD', 'Method not allowed.', 405);
  }

  async function oauthRoute(req: Request, path: string, method: string, ip: string): Promise<Response> {
    try {
      if (path === '/oauth/register' && method === 'POST') return json(oauth.register(await body(req), ip), 201);
      if (path === '/oauth/token' && method === 'POST') return json(oauth.token(await formParams(req)));
      if (path === '/oauth/authorize' && (method === 'GET' || method === 'POST')) {
        const params = method === 'GET' ? new URL(req.url).searchParams : await formParams(req);
        let ar;
        try {
          ar = oauth.parseAuthorize(params);
        } catch (e) {
          if (e instanceof OAuthError) return withHeaders(text(oauthErrorHtml(e.description), 'text/html; charset=utf-8', 400), { 'Content-Security-Policy': loginCsp("'none'") });
          throw e;
        }
        const redirect = new URL(ar.redirectUri);
        const csp = { 'Content-Security-Policy': loginCsp(redirect.origin) };
        const page = (error?: string, status = 200) =>
          withHeaders(text(oauthLoginHtml({ params, clientName: ar.clientName, redirectHost: redirect.host, error }), 'text/html; charset=utf-8', status), csp);
        if (method === 'GET') return page();
        if (params.get('action') === 'deny') return withHeaders(new Response(null, { status: 302, headers: { Location: oauth.denyRedirect(ar) } }), csp);
        try {
          return withHeaders(new Response(null, { status: 302, headers: { Location: oauth.approve(ar, params.get('owner_key') ?? '', ip), 'Cache-Control': 'no-store' } }), csp);
        } catch (e) {
          if (e instanceof OAuthError) return page(e.description, e.httpStatus);
          throw e;
        }
      }
      return errorJson('NOT_FOUND', 'Not found.', 404);
    } catch (e) {
      if (e instanceof OAuthError) return oauthJsonError(e);
      throw e;
    }
  }

  return async function handle(req: Request, ip: string): Promise<Response> {
    try {
      return withHeaders(await route(req, ip));
    } catch (e) {
      if (e instanceof ChatError) return withHeaders(errorJson(e.code, e.message, e.httpStatus));
      console.error('request error', e);
      return withHeaders(errorJson('INTERNAL', 'Internal error.', 500));
    }
  };
}
