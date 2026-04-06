/**
 * Dashboard web server for NanoClaw (Batcave Command Center).
 * Serves the compiled frontend/dist/ static files and JSON API endpoints.
 * Listens on WEB_HOST:3000 (default 0.0.0.0).
 * Cloudflare Access (email OTP) provides external authentication.
 * API endpoints additionally require X-Auth-Token or Authorization: Bearer header.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { ASSISTANT_NAME } from './config.js';
import {
  getAllRegisteredGroups,
  getAllTasks,
  getMessagesSince,
} from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { waState } from './wa-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
};

let server: http.Server | null = null;

// ── Integrations ──────────────────────────────────────────────────────────────

/** Map of integration type → credential file/dir path on the host. */
const CREDENTIAL_PATHS: Record<string, string> = {
  gmail: path.join(os.homedir(), '.gmail-mcp'),
  calendar: path.join(os.homedir(), '.calendar-mcp'),
  'calendar-token': path.join(os.homedir(), '.config', 'google-calendar-mcp'),
  todoist: path.join(os.homedir(), '.todoist-mcp'),
  voice: path.join(os.homedir(), '.voice-mcp'),
  x: path.join(os.homedir(), '.x-mcp'),
  google: path.join(os.homedir(), '.config', 'nanoclaw', 'google-credentials.json'),
};

const CONTACTS_TOGGLE_FILE = path.join(os.homedir(), '.config', 'nanoclaw', 'contacts-enabled');

/** Ensure the ~/.config/nanoclaw directory exists. */
function ensureNanoclawConfigDir(): void {
  fs.mkdirSync(path.join(os.homedir(), '.config', 'nanoclaw'), { recursive: true });
}

function getIntegrationStatus(): Record<string, { active: boolean; configuredAt: string | null }> {
  const result: Record<string, { active: boolean; configuredAt: string | null }> = {};

  for (const [key, credPath] of Object.entries(CREDENTIAL_PATHS)) {
    try {
      const stat = fs.statSync(credPath);
      result[key] = { active: true, configuredAt: stat.mtime.toISOString() };
    } catch {
      result[key] = { active: false, configuredAt: null };
    }
  }

  // Pipedream — check OAuth credentials present in process env
  const hasPipedream = !!(process.env.PIPEDREAM_CLIENT_ID && process.env.PIPEDREAM_CLIENT_SECRET);
  result['pipedream'] = { active: hasPipedream, configuredAt: null };

  // Contacts — toggled via marker file
  result['contacts'] = { active: fs.existsSync(CONTACTS_TOGGLE_FILE), configuredAt: null };

  return result;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunks.reduce((n, c) => n + c.length, 0) > 512 * 1024) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Run comparison anyway to avoid length-timing leaks
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorised(req: http.IncomingMessage, authToken: string): boolean {
  if (!authToken) return true; // No token configured — open (CF Access protects externally)
  const raw = req.headers['x-auth-token'] ?? req.headers['authorization'] ?? '';
  const provided = (Array.isArray(raw) ? raw[0] : raw).replace(/^Bearer\s+/i, '');
  return timingSafeCompare(provided, authToken);
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  // Normalise and strip leading traversal attempts
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const target = path.join(FRONTEND_DIR, safe);

  // Security: resolved path must stay inside FRONTEND_DIR
  const base = FRONTEND_DIR + path.sep;
  if (target !== FRONTEND_DIR && !target.startsWith(base)) {
    res.writeHead(403);
    res.end();
    return;
  }

  // SPA fallback to index.html for unknown paths
  let resolved = target;
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) resolved = path.join(FRONTEND_DIR, 'index.html');
  } catch {
    resolved = path.join(FRONTEND_DIR, 'index.html');
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME[ext] ?? 'application/octet-stream';

  try {
    const content = fs.readFileSync(resolved);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

export function startWebServer(port = 3000): void {
  if (server) return;

  const env = readEnvFile(['WEB_HOST', 'WEB_AUTH_TOKEN', 'WEB_PUBLIC_HOST']);
  const host = env.WEB_HOST ?? '0.0.0.0';
  const authToken = env.WEB_AUTH_TOKEN ?? '';

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    handleRequest(req, res, authToken, env, url).catch((err) => {
      logger.error({ err }, 'Unhandled error in HTTP handler');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  });

  server.listen(port, host, () => {
    logger.info({ port, host }, 'Web server listening');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Web server error');
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authToken: string,
  env: Record<string, string | undefined>,
  url: URL,
): Promise<void> {
  const { pathname } = url;

    // /health — no auth, for monitoring and the tunnel keepalive check
    if (req.method === 'GET' && pathname === '/health') {
      return json(res, {
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        whatsapp: waState.status,
      });
    }

    // All /api/* routes require token auth
    if (pathname.startsWith('/api/')) {
      if (!isAuthorised(req, authToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      // GET /api/status
      if (req.method === 'GET' && pathname === '/api/status') {
        const groups = getAllRegisteredGroups();
        const groupValues = Object.values(groups);
        return json(res, {
          whatsapp: waState.status,
          qrExpiresAt: waState.qrExpiresAt,
          uptime: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
          groups: {
            total: groupValues.length,
            active: groupValues.filter((g) => !g.listenOnly).length,
            listenOnly: groupValues.filter((g) => g.listenOnly).length,
          },
        });
      }

      // GET /api/auth/qr
      if (req.method === 'GET' && pathname === '/api/auth/qr') {
        return json(res, {
          status: waState.status,
          qrDataUrl: waState.qrDataUrl,
          qrExpiresAt: waState.qrExpiresAt,
        });
      }

      // GET /api/groups
      if (req.method === 'GET' && pathname === '/api/groups') {
        return json(res, getAllRegisteredGroups());
      }

      // GET /api/tasks
      if (req.method === 'GET' && pathname === '/api/tasks') {
        return json(res, getAllTasks());
      }

      // GET /api/messages?jid=<jid>&since=<iso>&limit=<n>
      if (req.method === 'GET' && pathname === '/api/messages') {
        const jid = url.searchParams.get('jid');
        if (!jid) return json(res, { error: 'jid parameter required' }, 400);
        const since =
          url.searchParams.get('since') ??
          new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const limitParam = parseInt(url.searchParams.get('limit') ?? '50', 10);
        const limit = isNaN(limitParam) ? 50 : Math.min(limitParam, 200);
        return json(res, getMessagesSince(jid, since, ASSISTANT_NAME, limit));
      }

      // GET /api/config
      if (req.method === 'GET' && pathname === '/api/config') {
        return json(res, {
          publicHost: env.WEB_PUBLIC_HOST ?? null,
          assistantName: ASSISTANT_NAME,
        });
      }

      // GET /api/integrations — live credential status
      if (req.method === 'GET' && pathname === '/api/integrations') {
        return json(res, getIntegrationStatus());
      }

      // POST /api/integrations/contacts/toggle
      if (req.method === 'POST' && pathname === '/api/integrations/contacts/toggle') {
        ensureNanoclawConfigDir();
        const active = fs.existsSync(CONTACTS_TOGGLE_FILE);
        if (active) {
          try { fs.unlinkSync(CONTACTS_TOGGLE_FILE); } catch { /* ignore */ }
        } else {
          fs.writeFileSync(CONTACTS_TOGGLE_FILE, new Date().toISOString(), { mode: 0o600 });
        }
        return json(res, { active: !active });
      }

      // POST /api/integrations/:type/upload — save credential JSON
      const uploadMatch = /^\/api\/integrations\/([a-z0-9-]+)\/upload$/.exec(pathname);
      if (req.method === 'POST' && uploadMatch) {
        const type = uploadMatch[1];
        const credPath = CREDENTIAL_PATHS[type];
        if (!credPath) return json(res, { error: 'Unknown integration type' }, 400);
        let body: string;
        try {
          body = await readBody(req);
          JSON.parse(body); // validate
        } catch {
          return json(res, { error: 'Invalid JSON' }, 400);
        }
        fs.mkdirSync(path.dirname(credPath), { recursive: true });
        fs.writeFileSync(credPath, body, { mode: 0o600 });
        logger.info({ type, credPath }, 'Integration credentials updated');
        return json(res, { ok: true });
      }

      // Drain unknown /api/integrations/* requests
      if (pathname.startsWith('/api/integrations')) {
        req.resume();
        return json(res, { error: 'Not found' }, 404);
      }

      return json(res, { error: 'Not found' }, 404);
    }

    // Everything else — serve frontend static files
    serveStatic(res, pathname);
}

export function stopWebServer(): void {
  server?.close();
  server = null;
}
