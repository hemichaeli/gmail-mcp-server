import crypto from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';

const AUTH_SECRET = process.env.AUTH_SECRET || '';
export const authEnabled = AUTH_SECRET.length > 0;

// SERVER_ID must be the same slug used as clientPrefix for this server (e.g. "gmail-mcp").
// It is mixed into the token derivation ON PURPOSE: it domain-separates the tokens so a
// bearer token minted for one server is useless against any other, even if two servers were
// accidentally given the same AUTH_SECRET. Do not remove it and do not make it generic.
const SERVER_ID = 'gmail-mcp';

const derive = (suffix: string) =>
  crypto.createHash('sha256').update(`${AUTH_SECRET}|${SERVER_ID}|${suffix}`).digest('hex');

const ACCESS_TOKEN = authEnabled ? derive('mcp-access') : '';
const REFRESH_TOKEN = authEnabled ? derive('mcp-refresh') : '';

// one-time authorization codes: code -> expiry epoch ms
const codes = new Map<string, number>();
const CODE_TTL_MS = 10 * 60 * 1000;

function issueCode(): string {
  const code = crypto.randomBytes(32).toString('hex');
  codes.set(code, Date.now() + CODE_TTL_MS);
  return code;
}

function consumeCode(code: string): boolean {
  const exp = codes.get(code);
  if (exp === undefined) return false;
  codes.delete(code);
  return exp > Date.now();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

function form(redirectUri: string, state: string, error?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Connect</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e8eaed;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}form{background:#151922;
padding:32px;border-radius:12px;width:320px}h1{font-size:16px;margin:0 0 4px}
p{font-size:13px;color:#9aa4b2;margin:0 0 20px}input{width:100%;box-sizing:border-box;
padding:10px;border-radius:8px;border:1px solid #2a3140;background:#0b0d12;color:#e8eaed;
font-size:14px}button{width:100%;margin-top:12px;padding:10px;border:0;border-radius:8px;
background:#4c8bf5;color:#fff;font-size:14px;cursor:pointer}
.e{color:#ff6b6b;font-size:13px;margin-top:12px}</style></head><body>
<form method="POST" action="/authorize">
<h1>MCP server access</h1><p>Enter the shared passphrase to connect.</p>
<input type="password" name="passphrase" autofocus required placeholder="Passphrase">
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<button type="submit">Connect</button>
${error ? `<div class="e">${escapeHtml(error)}</div>` : ''}
</form></body></html>`;
}

function sendJsonRaw(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function redirectBack(res: ServerResponse, redirectUri: string, state: string): void {
  const loc = new URL(redirectUri);
  loc.searchParams.set('code', issueCode());
  if (state) loc.searchParams.set('state', state);
  res.writeHead(302, { Location: loc.toString() });
  res.end();
}

/** Minimal request body reader (the repo has no existing helper). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseForm(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const params = new URLSearchParams(raw);
  for (const [k, v] of params) out[k] = v;
  return out;
}

function parseJsonBody(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Bearer check for the MCP transport endpoints. Always true when AUTH_SECRET is unset. */
export function checkBearer(req: IncomingMessage): boolean {
  if (!authEnabled) return true;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const expected = ACCESS_TOKEN;
  return (
    token.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  );
}

/** 401 + WWW-Authenticate pointing at the resource metadata, so Claude starts the OAuth flow. */
export function sendUnauthorized(res: ServerResponse, baseUrl: string): void {
  res.setHeader(
    'WWW-Authenticate',
    `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`
  );
  sendJsonRaw(res, 401, { error: 'invalid_token' });
}

/**
 * OAuth 2.1 discovery + DCR + authorize/token for native http servers.
 * Returns true if it handled the request, false otherwise.
 */
export async function handleOAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: { baseUrl: string; clientPrefix: string }
): Promise<boolean> {
  const { baseUrl, clientPrefix } = opts;
  const path = url.pathname;
  const method = req.method || 'GET';

  if (
    method === 'GET' &&
    (path === '/.well-known/oauth-protected-resource' ||
      path === '/.well-known/oauth-protected-resource/sse' ||
      path === '/.well-known/oauth-protected-resource/mcp')
  ) {
    sendJsonRaw(res, 200, {
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
    });
    return true;
  }

  if (
    method === 'GET' &&
    (path === '/.well-known/oauth-authorization-server' ||
      path === '/.well-known/openid-configuration')
  ) {
    sendJsonRaw(res, 200, {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
    return true;
  }

  if (method === 'POST' && path === '/register') {
    const meta = parseJsonBody(await readBody(req));
    sendJsonRaw(res, 201, {
      client_id: `${clientPrefix}-client`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [],
    });
    return true;
  }

  if (method === 'GET' && path === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri') || '';
    const state = url.searchParams.get('state') || '';
    if (!redirectUri) {
      sendJsonRaw(res, 400, {
        error: 'invalid_request',
        error_description: 'redirect_uri required',
      });
      return true;
    }
    if (!authEnabled) {
      redirectBack(res, redirectUri, state);
      return true;
    }
    sendHtml(res, 200, form(redirectUri, state));
    return true;
  }

  if (method === 'POST' && path === '/authorize') {
    const body = parseForm(await readBody(req));
    const redirectUri = body.redirect_uri || '';
    const state = body.state || '';
    if (!redirectUri) {
      sendJsonRaw(res, 400, {
        error: 'invalid_request',
        error_description: 'redirect_uri required',
      });
      return true;
    }
    if (!authEnabled) {
      redirectBack(res, redirectUri, state);
      return true;
    }
    const supplied = Buffer.from(body.passphrase || '');
    const expected = Buffer.from(AUTH_SECRET);
    const ok = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    if (!ok) {
      sendHtml(res, 401, form(redirectUri, state, 'Incorrect passphrase.'));
      return true;
    }
    redirectBack(res, redirectUri, state);
    return true;
  }

  if (method === 'POST' && path === '/token') {
    const body = parseForm(await readBody(req));
    if (authEnabled) {
      const grant = body.grant_type || 'authorization_code';
      const valid =
        grant === 'refresh_token'
          ? body.refresh_token === REFRESH_TOKEN
          : consumeCode(body.code || '');
      if (!valid) {
        sendJsonRaw(res, 400, { error: 'invalid_grant' });
        return true;
      }
    }
    sendJsonRaw(res, 200, {
      access_token: authEnabled ? ACCESS_TOKEN : `${clientPrefix}-token`,
      token_type: 'Bearer',
      expires_in: 315360000,
      refresh_token: authEnabled ? REFRESH_TOKEN : `${clientPrefix}-refresh`,
      scope: 'mcp',
    });
    return true;
  }

  return false;
}
