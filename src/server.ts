import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ChatService } from './chat.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './http.js';
import { createMcp } from './mcp.js';
import { OAuthService } from './oauth.js';

const MAX_BODY = 64 * 1024;

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const chats = new ChatService(db, cfg);
const oauth = new OAuthService(db, cfg);
const mcp = createMcp(chats, cfg, oauth);
const app = createApp({ cfg, chats, mcp, oauth });

function clientIp(req: IncomingMessage): string {
  if (cfg.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf;
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Minimal Node <-> fetch adapter: buffer the (small, capped) body, stream the response. */
async function handle(req: IncomingMessage, res: ServerResponse) {
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  let body: Buffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json' }).end('{"error":{"code":"TOO_LARGE","message":"Request body too large."}}');
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks);
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const val of Array.isArray(v) ? v : [v]) headers.append(k, val);
  }
  const request = new Request(new URL(req.url ?? '/', cfg.publicUrl), { method: req.method, headers, body: body ? new Uint8Array(body) : undefined, signal: abort.signal });

  const response = await app(request, clientIp(req));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body || req.method === 'HEAD') return void res.end();
  try {
    for await (const chunk of response.body) {
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    }
  } catch {
    // client went away mid-stream
  }
  res.end();
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('fatal request error', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 65_000;

// Delete chats past their archive period, hourly.
const sweep = () => {
  const n = chats.sweep();
  if (n) console.log(`sweep: deleted ${n} archived chat(s)`);
};
sweep();
setInterval(sweep, 3_600_000).unref();

server.listen(cfg.port, cfg.host, () => console.log(`agent-chat listening on ${cfg.host}:${cfg.port} (public URL ${cfg.publicUrl})`));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`${sig}: shutting down`);
    server.close();
    void mcp.close();
    db.close();
    process.exit(0);
  });
}
