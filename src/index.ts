import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { registerMessageTools } from './tools/messages.js';
import { registerDraftTools } from './tools/drafts.js';
import { registerLabelTools } from './tools/labels.js';
import { registerThreadTools } from './tools/threads.js';
import { registerProfileTools } from './tools/profile.js';
import { authEnabled, checkBearer, sendUnauthorized, handleOAuthRoute } from './mcp-auth.js';
import { installProcessGuards, guardSseSocket } from './process-guards.js';

installProcessGuards('gmail-mcp');

const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_URL =
  process.env.SERVER_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
    : 'http://localhost:' + PORT);
const transports: Record<string, SSEServerTransport> = {};

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'gmail-mcp-server', version: '2.1.1' });
  registerMessageTools(server);
  registerDraftTools(server);
  registerLabelTools(server);
  registerThreadTools(server);
  registerProfileTools(server);
  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok', server: 'gmail-mcp-server', version: '2.1.1',
      tools: 35, activeSessions: Object.keys(transports).length,
      auth: authEnabled,
      features: ['attachments', 'multipart-mime', 'draft-attachments']
    });
    return;
  }

  if (await handleOAuthRoute(req, res, url, { baseUrl: BASE_URL, clientPrefix: 'gmail-mcp' })) {
    return;
  }

  if (req.method === 'GET' && url.pathname === '/sse') {
    if (!checkBearer(req)) { sendUnauthorized(res, BASE_URL); return; }
    guardSseSocket(req, res, 'gmail-mcp-sse');
    console.error('[Gmail MCP] New SSE connection');
    try {
      const transport = new SSEServerTransport('/messages', res);
      const sessionId = transport.sessionId;
      transports[sessionId] = transport;
      console.error(`[Gmail MCP] Transport created: ${sessionId}`);

      req.on('close', () => {
        console.error(`[Gmail MCP] Request closed: ${sessionId}`);
        delete transports[sessionId];
      });

      const server = buildMcpServer();
      console.error('[Gmail MCP] Server instance created');

      await server.connect(transport);
      console.error(`[Gmail MCP] Connected: ${sessionId}`);
    } catch (error) {
      console.error('[Gmail MCP] Error:', error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'SSE connection failed' });
      }
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages') {
    if (!checkBearer(req)) { sendUnauthorized(res, BASE_URL); return; }
    const sessionId = url.searchParams.get('sessionId') || '';
    const transport = transports[sessionId];
    if (!transport) { sendJson(res, 404, { error: `No session: ${sessionId}` }); return; }
    try {
      await transport.handlePostMessage(req, res);
    } catch (error) {
      console.error(`[Gmail MCP] Post error:`, error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Message handling failed' });
      }
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

httpServer.listen(PORT, () => {
  console.error(`[Gmail MCP] v2.1.1 on port ${PORT}`);
  console.error(`[Gmail MCP] SSE: http://localhost:${PORT}/sse`);
  console.error('[Gmail MCP] Tools: 35');
});
