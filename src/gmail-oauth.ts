import { IncomingMessage, ServerResponse } from 'node:http';
import { OAuth2Client } from 'google-auth-library';

const GMAIL_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
];

function getRedirectUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/oauth/gmail/callback`;
}

function getFlowClient(baseUrl: string): OAuth2Client {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET');
  return new OAuth2Client(clientId, clientSecret, getRedirectUri(baseUrl));
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export async function handleGmailOAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: { baseUrl: string }
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  // Start: redirect user to Google consent screen with full scope set
  if (url.pathname === '/oauth/gmail/start') {
    try {
      const client = getFlowClient(ctx.baseUrl);
      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: GMAIL_SCOPES,
        include_granted_scopes: true,
      });
      res.writeHead(302, { Location: authUrl });
      res.end();
    } catch (err) {
      sendHtml(res, 500, `<h1>OAuth start failed</h1><pre>${esc(err instanceof Error ? err.message : String(err))}</pre>`);
    }
    return true;
  }

  // Callback: exchange code for tokens, render refresh token page
  if (url.pathname === '/oauth/gmail/callback') {
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    if (err) {
      sendHtml(res, 400, `<h1>Authorization denied</h1><p>${esc(err)}</p><p><a href="/oauth/gmail/start">Try again</a></p>`);
      return true;
    }
    if (!code) {
      sendHtml(res, 400, `<h1>Missing code</h1><p><a href="/oauth/gmail/start">Start over</a></p>`);
      return true;
    }
    try {
      const client = getFlowClient(ctx.baseUrl);
      const { tokens } = await client.getToken(code);
      const rt = tokens.refresh_token || '';
      const scopes = (tokens.scope || '').split(/\s+/).filter(Boolean);
      const missing = GMAIL_SCOPES.filter(s => !scopes.includes(s));

      const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>Gmail MCP - Refresh Token</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 780px; margin: 40px auto; padding: 0 20px; color: #222; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  .card { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .ok { border-color: #1a7f37; background: #dafbe1; }
  .warn { border-color: #9a6700; background: #fff8c5; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { white-space: pre-wrap; word-break: break-all; background: #fff; border: 1px solid #d0d7de; padding: 12px; border-radius: 6px; margin: 0; font-size: 13px; }
  button { background: #1f6feb; color: #fff; border: 0; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 14px; margin-top: 8px; }
  button:hover { background: #1a5cc4; }
  ul { margin: 6px 0 0 20px; padding: 0; }
  li { margin: 2px 0; font-size: 13px; }
</style></head>
<body>
<h1>Gmail MCP - Refresh Token</h1>
${rt ? `<div class="card ok"><b>Refresh token issued.</b> Copy and send it to Claude to update Railway env <code>GMAIL_REFRESH_TOKEN</code>.</div>` : `<div class="card warn"><b>No refresh_token returned.</b> This usually means the app already has a token for this user - revoke it at <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a> and try again.</div>`}
${rt ? `<pre id="rt">${esc(rt)}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('rt').innerText).then(()=>this.innerText='Copied!')">Copy refresh token</button>` : ''}
<div class="card"><b>Granted scopes (${scopes.length})</b><ul>${scopes.map(s => `<li><code>${esc(s)}</code></li>`).join('')}</ul></div>
${missing.length ? `<div class="card warn"><b>Missing scopes (${missing.length})</b> - the Google Cloud project's OAuth consent screen may not have these enabled.<ul>${missing.map(s => `<li><code>${esc(s)}</code></li>`).join('')}</ul></div>` : `<div class="card ok"><b>All required scopes granted.</b></div>`}
</body></html>`;
      sendHtml(res, 200, page);
    } catch (e) {
      sendHtml(res, 500, `<h1>Token exchange failed</h1><pre>${esc(e instanceof Error ? e.message : String(e))}</pre><p><a href="/oauth/gmail/start">Start over</a></p>`);
    }
    return true;
  }

  return false;
}

export const GMAIL_OAUTH_SCOPES = GMAIL_SCOPES;
