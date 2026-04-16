import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { registerMessageTools } from './tools/messages.js';
import { registerDraftTools } from './tools/drafts.js';
import { registerLabelTools } from './tools/labels.js';
import { registerThreadTools } from './tools/threads.js';
import { registerProfileTools } from './tools/profile.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

const transports: Record<string, SSEServerTransport> = {};

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'gmail-mcp-server', version: '1.0.0' });
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

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      server: 'gmail-mcp-server',
      version: '1.0.0',
      tools: 34,
      activeSessions: Object.keys(transports).length,
    });
    return;
  }

  // SSE endpoint - establishes connection
  if (req.method === 'GET' && url.pathname === '/sse') {
    console.error('[Gmail MCP] New SSE connection');
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    transports[sessionId] = transport;

    req.on('close', () => {
      console.error(`[Gmail MCP] SSE connection closed: ${sessionId}`);
      delete transports[sessionId];
    });

    const server = buildMcpServer();
    await server.connect(transport);
    return;
  }

  // Messages endpoint - handles MCP messages
  if (req.method === 'POST' && url.pathname === '/messages') {
    const sessionId = url.searchParams.get('sessionId') || '';
    const transport = transports[sessionId];

    if (!transport) {
      sendJson(res, 404, { error: `No active session: ${sessionId}` });
      return;
    }

    await transport.handlePostMessage(req, res);
    return;
  }

  // 404
  sendJson(res, 404, { error: 'Not found' });
});

httpServer.listen(PORT, () => {
  console.error(`[Gmail MCP] Server running on port ${PORT}`);
  console.error(`[Gmail MCP] SSE endpoint: http://localhost:${PORT}/sse`);
  console.error(`[Gmail MCP] Tools registered: 34`);
  console.error(`[Gmail MCP]   - Messages: 13 | Drafts: 6 | Labels: 5 | Threads: 5 | Profile/Filters/History: 5`);
});
