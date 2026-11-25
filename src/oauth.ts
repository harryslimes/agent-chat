import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';
import { RateLimiter } from './guards.js';
import { hash, newToken, safeEqual } from './secrets.js';

/**
 * Minimal single-user OAuth 2.1 authorization server for the owner connector.
 *
 * Why: claude.ai custom connectors can't send a custom Authorization header, only
 * OAuth, so a phone could never present the owner key. This lets the owner log in
 * once (typing the owner key on our own page) and gives the client short-lived,
 * revocable tokens instead.
 *
 * Scope: authorization code + PKCE (S256 only), dynamic client registration
 * restricted to allowlisted redirect hosts, refresh-token rotation. Only hashes of
 * codes and tokens are stored. Every token grants exactly "owner" on this server.
 */

const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const MAX_CLIENTS = 50;

export const OWNER_MCP_PATH = '/mcp/owner';

export class OAuthError extends Error {
  constructor(public error: string, public description: string, public httpStatus = 400) {
    super(description);
  }
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
}

export interface AuthorizeRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export class OAuthService {
  private registerLimiter = new RateLimiter(10, 3_600_000);
  private loginLimiter = new RateLimiter(10, 3_600_000);

  constructor(private db: DatabaseSync, private cfg: Config) {
    setInterval(() => this.prune(), 10 * 60 * 1000).unref();
  }

  get issuer(): string {
    return this.cfg.publicUrl;
  }

  get resource(): string {
    return `${this.cfg.publicUrl}${OWNER_MCP_PATH}`;
  }

  get resourceMetadataUrl(): string {
    return `${this.cfg.publicUrl}/.well-known/oauth-protected-resource${OWNER_MCP_PATH}`;
  }

  /** RFC 9728 protected resource metadata. */
  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ['header'],
      resource_name: 'agent-chat (owner)',
    };
  }

  /** RFC 8414 authorization server metadata. */
  authServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['owner'],
    };
  }

  // ---------- registration (RFC 7591) ----------

  register(body: Record<string, unknown>, ip: string) {
    if (!this.registerLimiter.hit(ip)) throw new OAuthError('slow_down', 'Too many registrations from your address.', 429);
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (!uris.length || uris.length > 5) throw new OAuthError('invalid_redirect_uri', 'Provide 1-5 redirect_uris.');
    for (const u of uris) this.checkRedirect(u);
    const count = (this.db.prepare(`SELECT COUNT(*) AS n FROM oauth_clients`).get() as { n: number }).n;
    if (count >= MAX_CLIENTS) this.pruneClients(true);
    const clientId = newToken('cl');
    const name = (typeof body.client_name === 'string' ? body.client_name : 'MCP client').replace(/[^\p{L}\p{N} .'_()-]/gu, '').slice(0, 60) || 'MCP client';
    this.db.prepare(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)`).run(clientId, name, JSON.stringify(uris), Date.now());
    return {
      client_id: clientId,
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  /** Redirects must be https on an allowlisted host (or http on loopback, for CLI clients). */
  private checkRedirect(uri: string): URL {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      throw new OAuthError('invalid_redirect_uri', 'Redirect URI is not a valid URL.');
    }
    const host = u.hostname.toLowerCase();
    const loopback = host === 'localhost' || host === '127.0.0.1';
    const allowed = this.cfg.oauthRedirectHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!allowed) throw new OAuthError('invalid_redirect_uri', `Redirect host ${host} is not allowed on this server.`);
    if (u.protocol !== 'https:' && !(loopback && u.protocol === 'http:')) throw new OAuthError('invalid_redirect_uri', 'Redirect URI must use https.');
    if (u.hash) throw new OAuthError('invalid_redirect_uri', 'Redirect URI must not contain a fragment.');
    return u;
  }

  private client(clientId: string): ClientRow {
    const row = this.db.prepare(`SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?`).get(clientId) as ClientRow | undefined;
    if (!row) throw new OAuthError('invalid_client', 'Unknown client. Re-add the connector.', 401);
    return row;
  }

  // ---------- authorization ----------

  /**
   * Validate an authorize request (GET query or POSTed form). Errors here are shown on
   * our page, never redirected, because an unverified redirect_uri can't be trusted.
   */
  parseAuthorize(p: URLSearchParams): AuthorizeRequest {
    if (p.get('response_type') !== 'code') throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported.');
    const client = this.client(p.get('client_id') ?? '');
    const redirectUri = p.get('redirect_uri') ?? '';
    const registered = JSON.parse(client.redirect_uris) as string[];
    if (!registered.includes(redirectUri)) throw new OAuthError('invalid_request', 'redirect_uri does not match the registered client.');
    const codeChallenge = p.get('code_challenge') ?? '';
    if (p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
      throw new OAuthError('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    }
    const resource = p.get('resource');
    if (resource && resource.replace(/\/+$/, '') !== this.resource && resource.replace(/\/+$/, '') !== `${this.cfg.publicUrl}/mcp`) {
      throw new OAuthError('invalid_target', 'Unknown resource.');
    }
    return { clientId: client.client_id, clientName: client.client_name, redirectUri, state: p.get('state') ?? '', codeChallenge };
  }

  /** Check the owner key typed on the login page and mint a one-time code. Returns the redirect URL. */
  approve(req: AuthorizeRequest, ownerKey: string, ip: string): string {
    if (!this.loginLimiter.hit(ip)) throw new OAuthError('slow_down', 'Too many login attempts from your address. Try again later.', 429);
    if (!safeEqual(ownerKey.trim(), this.cfg.ownerKey)) throw new OAuthError('access_denied', 'That owner key is not correct.', 403);
    const code = newToken('oc');
    this.db.prepare(`INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(hash(code), req.clientId, req.redirectUri, req.codeChallenge, Date.now() + CODE_TTL_MS);
    const target = new URL(req.redirectUri);
    target.searchParams.set('code', code);
    if (req.state) target.searchParams.set('state', req.state);
    target.searchParams.set('iss', this.issuer);
    return target.toString();
  }

  /** Where the user goes if they press Cancel. */
  denyRedirect(req: AuthorizeRequest): string {
    const target = new URL(req.redirectUri);
    target.searchParams.set('error', 'access_denied');
    if (req.state) target.searchParams.set('state', req.state);
    return target.toString();
  }

  // ---------- token endpoint ----------

  token(p: URLSearchParams) {
    const grant = p.get('grant_type');
    if (grant === 'authorization_code') return this.exchangeCode(p);
    if (grant === 'refresh_token') return this.refresh(p);
    throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }

  private exchangeCode(p: URLSearchParams) {
    const code = p.get('code') ?? '';
    const row = this.db.prepare(`SELECT client_id, redirect_uri, challenge, expires_at FROM oauth_codes WHERE code_hash = ?`).get(hash(code)) as
      | { client_id: string; redirect_uri: string; challenge: string; expires_at: number }
      | undefined;
    // Single use: delete before checking anything else.
    this.db.prepare(`DELETE FROM oauth_codes WHERE code_hash = ?`).run(hash(code));
    if (!row || row.expires_at < Date.now()) throw new OAuthError('invalid_grant', 'Code is invalid or expired.');
    if (row.client_id !== p.get('client_id')) throw new OAuthError('invalid_grant', 'Code was issued to a different client.');
    if (row.redirect_uri !== p.get('redirect_uri')) throw new OAuthError('invalid_grant', 'redirect_uri mismatch.');
    const verifier = p.get('code_verifier') ?? '';
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64url(createHash('sha256').update(verifier).digest()) !== row.challenge) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed.');
    }
    return this.issue(row.client_id);
  }

  private refresh(p: URLSearchParams) {
    const token = p.get('refresh_token') ?? '';
    const row = this.db.prepare(`SELECT client_id, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`).get(hash(token)) as
      | { client_id: string; expires_at: number }
      | undefined;
    // Rotation: a refresh token works once.
    this.db.prepare(`DELETE FROM oauth_tokens WHERE token_hash = ?`).run(hash(token));
    if (!row || row.expires_at < Date.now()) throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired. Reconnect the connector.');
    const clientId = p.get('client_id');
    if (clientId && clientId !== row.client_id) throw new OAuthError('invalid_grant', 'Refresh token was issued to a different client.');
    return this.issue(row.client_id);
  }

  private issue(clientId: string) {
    const access = newToken('at');
    const refresh = newToken('rt');
    const now = Date.now();
    const insert = this.db.prepare(`INSERT INTO oauth_tokens (token_hash, kind, client_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`);
    insert.run(hash(access), 'access', clientId, now + ACCESS_TTL_MS, now);
    insert.run(hash(refresh), 'refresh', clientId, now + REFRESH_TTL_MS, now);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: 'owner' };
  }

  /** True when the bearer token is a live access token. */
  verifyAccess(token: string): boolean {
    if (!token.startsWith('at_')) return false;
    const row = this.db.prepare(`SELECT expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'`).get(hash(token)) as { expires_at: number } | undefined;
    return !!row && row.expires_at > Date.now();
  }

  /** Revoke every token and client (owner action). Connected apps must log in again. */
  revokeAll(): { tokens: number; clients: number } {
    const tokens = Number(this.db.prepare(`DELETE FROM oauth_tokens`).run().changes);
    this.db.prepare(`DELETE FROM oauth_codes`).run();
    const clients = Number(this.db.prepare(`DELETE FROM oauth_clients`).run().changes);
    return { tokens, clients };
  }

  // ---------- housekeeping ----------

  private prune() {
    const now = Date.now();
    this.db.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?`).run(now);
    this.db.prepare(`DELETE FROM oauth_tokens WHERE expires_at < ?`).run(now);
    this.pruneClients(false);
  }

  /** Drop clients that never got a token after a day (abandoned registrations); `aggressive` drops all tokenless ones. */
  private pruneClients(aggressive: boolean) {
    const cutoff = aggressive ? Date.now() : Date.now() - 24 * 60 * 60 * 1000;
    this.db.prepare(`DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT DISTINCT client_id FROM oauth_tokens)`).run(cutoff);
  }
}
