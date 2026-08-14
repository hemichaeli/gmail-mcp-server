import { IncomingMessage, ServerResponse } from 'node:http';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const REQUIRED_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
];

function html(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Gmail MCP OAuth</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.5}
  h1{color:#1a73e8;font-size:24px}
  h2{font-size:18px;margin-top:32px}
  .box{background:#f5f7fa;border:1px solid #e0e4e8;border-radius:8px;padding:16px;margin:16px 0}
  .token{background:#0f172a;color:#4ade80;padding:16px;border-radius:8px;font-family:'SF Mono',Monaco,monospace;font-size:13px;word-break:break-all;user-select:all;cursor:text}
  .ok{color:#0f9d58;font-weight:600}
  .err{color:#d93025;font-weight:600}
  code{background:#f0f0f0;padding:2px 6px;border-radius:4px;font-family:'SF Mono',Monaco,monospace;font-size:13px}
  .btn{display:inline-block;background:#1a73e8;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:500}
  ol li{margin:8px 0}
</style></head><body>${body}</body></html>`;
}

export async function handleGmailOAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  baseUrl: string
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  // Route 1: /oauth/gmail/start - initiate OAuth flow
  if (url.pathname === '/oauth/gmail/start') {
    const clientId = process.env.GMAIL_CLIENT_ID;
    if (!clientId) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(html('<h1 class="err">Missing GMAIL_CLIENT_ID env var</h1>'));
      return true;
    }

    const redirectUri = `${baseUrl}/oauth/gmail/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: REQUIRED_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });

    res.writeHead(302, { Location: `${GOOGLE_AUTH_URL}?${params.toString()}` });
    res.end();
    return true;
  }

  // Route 2: /oauth/gmail/callback - handle Google's redirect
  if (url.pathname === '/oauth/gmail/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(html(`<h1 class="err">OAuth error</h1><p>${error}</p><p>${url.searchParams.get('error_description') || ''}</p>`));
      return true;
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(html('<h1 class="err">No authorization code returned</h1>'));
      return true;
    }

    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(html('<h1 class="err">Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET env vars</h1>'));
      return true;
    }

    const redirectUri = `${baseUrl}/oauth/gmail/callback`;

    try {
      const body = new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });

      const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const data = await tokenResponse.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        error?: string;
        error_description?: string;
      };

      if (!tokenResponse.ok || data.error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(html(`<h1 class="err">Token exchange failed</h1><p>${data.error || tokenResponse.status}</p><p>${data.error_description || ''}</p>`));
        return true;
      }

      if (!data.refresh_token) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(html(`
          <h1 class="err">No refresh_token returned</h1>
          <p>This usually means Google already issued one for this client and won't issue another. Go to <a href="https://myaccount.google.com/permissions">Google Account permissions</a>, remove the app, and try again.</p>
          <pre>${JSON.stringify(data, null, 2)}</pre>
        `));
        return true;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html(`
        <h1 class="ok">✓ Refresh token generated</h1>
        <p>Copy the token below and update the <code>GMAIL_REFRESH_TOKEN</code> environment variable in Railway:</p>
        <div class="token">${data.refresh_token}</div>
        <h2>Granted scopes</h2>
        <div class="box"><code>${(data.scope || '').split(' ').join('<br>')}</code></div>
        <h2>What to do next</h2>
        <ol>
          <li>Copy the refresh token above</li>
          <li>Send it to Claude in the chat</li>
          <li>Claude will update Railway and trigger a redeploy</li>
        </ol>
      `));
      return true;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(html(`<h1 class="err">Exception during token exchange</h1><pre>${err instanceof Error ? err.message : String(err)}</pre>`));
      return true;
    }
  }

  // Route 3: /oauth/gmail - landing page
  if (url.pathname === '/oauth/gmail') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html(`
      <h1>Gmail MCP OAuth Refresh</h1>
      <p>Generate a new refresh token for the Gmail MCP server with all required scopes.</p>
      <h2>Requested scopes</h2>
      <div class="box"><code>${REQUIRED_SCOPES.join('<br>')}</code></div>
      <h2>Redirect URI (must be authorized in Google Cloud Console)</h2>
      <div class="box"><code>${baseUrl}/oauth/gmail/callback</code></div>
      <p style="margin-top:32px"><a href="/oauth/gmail/start" class="btn">Start OAuth flow →</a></p>
    `));
    return true;
  }

  return false;
}
