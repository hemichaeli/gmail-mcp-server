import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { registerMessageTools } from './tools/messages';
import { registerDraftTools } from './tools/drafts';
import { registerLabelTools } from './tools/labels';
import { registerThreadTools } from './tools/threads';
import { registerProfileTools } from './tools/profile';

const PORT = parseInt(process.env.PORT || '3000', 10);

function createServer(): McpServer {
  const server = new McpServer({
    name: 'gmail-mcp-server',
    version: '1.0.0',
  });

  registerMessageTools(server);
  registerDraftTools(server);
  registerLabelTools(server);
  registerThreadTools(server);
  registerProfileTools(server);

  return server;
}

async function main() {
  const app = express();

  const transports: Record<string, SSEServerTransport> = {};

  app.get('/sse', async (req, res) => {
    console.error('[Gmail MCP] New SSE connection');
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    transports[sessionId] = transport;

    res.on('close', () => {
      console.error(`[Gmail MCP] SSE connection closed: ${sessionId}`);
      delete transports[sessionId];
    });

    const server = createServer();
    await server.connect(transport);
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports[sessionId];

    if (!transport) {
      res.status(404).json({ error: `No active session: ${sessionId}` });
      return;
    }

    await transport.handlePostMessage(req, res);
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      server: 'gmail-mcp-server',
      version: '1.0.0',
      tools: 34,
      activeSessions: Object.keys(transports).length,
    });
  });

  app.listen(PORT, () => {
    console.error(`[Gmail MCP] Server running on port ${PORT}`);
    console.error(`[Gmail MCP] SSE endpoint: http://localhost:${PORT}/sse`);
    console.error(`[Gmail MCP] Tools registered: 34`);
  });
}

main().catch((error) => {
  console.error('[Gmail MCP] Fatal error:', error);
  process.exit(1);
});
