import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse';
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

  // Register all tool groups
  registerMessageTools(server);  // 13 tools
  registerDraftTools(server);    // 6 tools
  registerLabelTools(server);    // 5 tools
  registerThreadTools(server);   // 5 tools
  registerProfileTools(server);  // 5 tools

  return server;
}

async function main() {
  const app = express();

  // Track active transports for cleanup
  const transports: Record<string, SSEServerTransport> = {};

  // SSE endpoint - establishes connection
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

  // Messages endpoint - DO NOT use express.json() middleware globally
  // It would consume the raw stream before the MCP SDK can read it
  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports[sessionId];

    if (!transport) {
      res.status(404).json({ error: `No active session: ${sessionId}` });
      return;
    }

    await transport.handlePostMessage(req, res);
  });

  // Health check
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
    console.error(`[Gmail MCP] Health check: http://localhost:${PORT}/health`);
    console.error(`[Gmail MCP] Tools registered: 34`);
    console.error(`[Gmail MCP]   - Messages: 13 tools`);
    console.error(`[Gmail MCP]   - Drafts: 6 tools`);
    console.error(`[Gmail MCP]   - Labels: 5 tools`);
    console.error(`[Gmail MCP]   - Threads: 5 tools`);
    console.error(`[Gmail MCP]   - Profile/Filters/History: 5 tools`);
  });
}

main().catch((error) => {
  console.error('[Gmail MCP] Fatal error:', error);
  process.exit(1);
});
