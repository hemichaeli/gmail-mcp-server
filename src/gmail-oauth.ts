import { IncomingMessage, ServerResponse } from 'node:http';
import { OAuth2Client } from 'google-auth-library';

const REQUIRED_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
];

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c] as string));
}

function requiredEnv(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export async function handleGmailOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  baseUrl: string
): Promise<boolean> {
  const env = requiredEnv();
  if (!env) return false;

  const redirectUri = `${baseUrl}/oauth/gmail/callback`;

  // Landing page - shows the setup + link to start the flow
  if (req.method === 'GET' && url.pathname === '/oauth/gmail') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Gmail MCP - OAuth Setup</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:24px;background:#0d1117;color:#c9d1d9;line-height:1.55}
  .card{background:#161b22;padding:24px;border-radius:10px;border:1px solid #30363d;margin-bottom:16px}
  h1{margin:0 0 12px;font-size:22px}
  h2{font-size:15px;margin:20px 0 8px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px}
  code{background:#0d1117;padding:2px 6px;border-radius:4px;border:1px solid #30363d;font-size:13px;color:#79c0ff}
  pre{background:#0d1117;padding:12px;border-radius:6px;border:1px solid #30363d;overflow:auto;font-size:12px;color:#79c0ff}
  .btn{display:inline-block;background:#238636;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:12px}
  .btn:hover{background:#2ea043}
  ol{padding-left:22px}
  li{margin-bottom:6px}
  .warn{background:#3d2817;border:1px solid #5c3617;color:#f0883e;padding:12px;border-radius:6px;font-size:13px}
</style></head><body>
<div class="card">
  <h1>Gmail MCP - OAuth Refresh Token Generator</h1>
  <p>Generates a fresh <code>GMAIL_REFRESH_TOKEN</code> with all scopes needed by this server (messages + settings).</p>

  <h2>Prerequisite (one time)</h2>
  <ol>
    <li>Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color:#79c0ff">Google Cloud Console - Credentials</a></li>
    <li>Open the OAuth 2.0 Client you use for this project</li>
    <li>Under <b>Authorized redirect URIs</b>, add: <pre>${esc(redirectUri)}</pre></li>
    <li>Save</li>
  </ol>

  <h2>Scopes that will be requested</h2>
  <pre>${REQUIRED_SCOPES.map(esc).join('\n')}</pre>

  <a class="btn" href="/oauth/gmail/start">Start OAuth flow</a>

  <div class="warn" style="margin-top:20px">If Google shows "App not verified", click <b>Advanced</b> then <b>Go to (unsafe)</b>. This is your own private OAuth app.</div>
</div>
</body></html>`);
    return true;
  }

  // Start flow: redirect to Google
  if (req.method === 'GET' && url.pathname === '/oauth/gmail/start') {
    const client = new OAuth2Client(env.clientId, env.clientSecret, redirectUri);
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // force refresh_token every time
      scope: REQUIRED_SCOPES,
      include_granted_scopes: true,
    });
    res.writeHead(302, { Location: authUrl });
    res.end();
    return true;
  }

  // Callback: exchange code for tokens
  if (req.method === 'GET' && url.pathname === '/oauth/gmail/callback') {
    const code = url.searchParams.get('code');
    const oauthError = url.searchParams.get('error');

    if (oauthError) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>OAuth Error</h1><p>${esc(oauthError)}</p><p><a href="/oauth/gmail">Try again</a></p>`);
      return true;
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>Missing authorization code</h1><p><a href="/oauth/gmail">Try again</a></p>`);
      return true;
    }

    try {
      const client = new OAuth2Client(env.clientId, env.clientSecret, redirectUri);
      const { tokens } = await client.getToken(code);
      const refreshToken = tokens.refresh_token;
      const grantedScopes = tokens.scope || '';

      if (!refreshToken) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>No refresh token returned</h1>
<p>Google skipped consent (already granted). Revoke the app at <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a> and try again.</p>`);
        return true;
      }

      // Verify all required scopes were granted
      const missing = REQUIRED_SCOPES.filter(s => !grantedScopes.includes(s));

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Gmail MCP - Token Ready</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:24px;background:#0d1117;color:#c9d1d9;line-height:1.55}
  .card{background:#161b22;padding:24px;border-radius:10px;border:1px solid #30363d}
  h1{margin:0 0 12px;font-size:22px;color:#3fb950}
  h2{font-size:14px;margin:20px 0 8px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px}
  pre{background:#0d1117;padding:14px;border-radius:6px;border:1px solid #30363d;overflow:auto;font-size:11px;color:#79c0ff;word-break:break-all;white-space:pre-wrap}
  .token{color:#3fb950;font-size:12px}
  .warn{background:#3d2817;border:1px solid #5c3617;color:#f0883e;padding:12px;border-radius:6px;font-size:13px;margin-top:12px}
  .ok{background:#0f2417;border:1px solid #1e4a2e;color:#3fb950;padding:12px;border-radius:6px;font-size:13px;margin-top:12px}
  button{background:#238636;color:#fff;border:0;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:600;margin-top:8px}
  button:hover{background:#2ea043}
</style></head><body>
<div class="card">
  <h1>Refresh Token Generated</h1>

  <h2>Refresh token (copy this)</h2>
  <pre id="tok" class="token">${esc(refreshToken)}</pre>
  <button onclick="navigator.clipboard.writeText(document.getElementById('tok').textContent).then(()=>this.textContent='Copied')">Copy to clipboard</button>

  <h2>Granted scopes</h2>
  <pre>${esc(grantedScopes.split(' ').join('\n'))}</pre>

  ${missing.length === 0
    ? `<div class="ok">All required scopes granted.</div>`
    : `<div class="warn">Missing scopes: ${missing.map(esc).join(', ')}<br>Make sure your OAuth consent screen has these scopes enabled.</div>`
  }

  <h2>Next step</h2>
  <p>Paste this refresh token back into the chat. It will be written to Railway env <code>GMAIL_REFRESH_TOKEN</code>.</p>
</div>
</body></html>`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>Token exchange failed</h1><pre>${esc(msg)}</pre><p><a href="/oauth/gmail">Try again</a></p>`);
      return true;
    }
  }

  return false;
}
