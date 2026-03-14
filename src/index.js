/**
 * mcp-recall — Self-hosted MCP memory server
 *
 * Provides semantic memory storage and retrieval for AI assistants
 * via the Model Context Protocol over SSE and Streamable HTTP transports.
 *
 * Stack: Node.js + PostgreSQL/pgvector + Xenova/transformers (local ONNX)
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { runMigrations, createMemory, searchMemories, listMemories,
         getMemory, updateMemory, deleteMemory, getStats, closePool } from './database.js';
import { initEmbeddings, generateEmbedding } from './embeddings.js';
import { initAuth, authMiddleware } from './auth.js';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

// Track active SSE sessions
const sessions = new Map();
// Track Streamable HTTP sessions
const httpSessions = new Map();

function createMcpServer() {
  const server = new McpServer({
    name: 'mcp-recall',
    version: '0.2.0',
  });

  // --- Tool: memory_store ---
  server.tool(
    'memory_store',
    'Store a new memory. Use this to remember facts, decisions, preferences, or any information that should persist across conversations.',
    {
      content: z.string().describe('The information to remember'),
      tags: z.array(z.string()).optional().describe('Tags for categorization (e.g. ["project", "infrastructure"])'),
      metadata: z.record(z.any()).optional().describe('Optional structured metadata as key-value pairs'),
    },
    async ({ content, tags, metadata }) => {
      const embedding = await generateEmbedding(content);
      const memory = await createMemory(content, metadata, tags, embedding);
      return {
        content: [{ type: 'text', text: `Stored memory ${memory.id}:\n${memory.content}` }],
      };
    }
  );

  // --- Tool: memory_search ---
  server.tool(
    'memory_search',
    'Search memories by semantic similarity. Returns the most relevant memories for a given query.',
    {
      query: z.string().describe('Natural language search query'),
      limit: z.number().optional().default(10).describe('Maximum results to return (default: 10)'),
      tags: z.array(z.string()).optional().describe('Filter by tags (memories must have at least one matching tag)'),
    },
    async ({ query, limit, tags }) => {
      const embedding = await generateEmbedding(query);
      const results = await searchMemories(embedding, { tags, limit });

      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No matching memories found.' }] };
      }

      const formatted = results.map((r, i) =>
        `[${i + 1}] (${(r.similarity * 100).toFixed(1)}% match) ${r.content}` +
        (r.tags.length ? `\n    Tags: ${r.tags.join(', ')}` : '') +
        (Object.keys(r.metadata || {}).length ? `\n    Metadata: ${JSON.stringify(r.metadata)}` : '') +
        `\n    ID: ${r.id} | Created: ${r.created_at.toISOString()}`
      ).join('\n\n');

      return { content: [{ type: 'text', text: formatted }] };
    }
  );

  // --- Tool: memory_update ---
  server.tool(
    'memory_update',
    'Update an existing memory by ID. Re-embeds if content changes.',
    {
      id: z.string().uuid().describe('Memory UUID to update'),
      content: z.string().optional().describe('New content (triggers re-embedding)'),
      tags: z.array(z.string()).optional().describe('New tags (replaces existing)'),
      metadata: z.record(z.any()).optional().describe('New metadata (replaces existing)'),
    },
    async ({ id, content, tags, metadata }) => {
      const existing = await getMemory(id);
      if (!existing) {
        return { content: [{ type: 'text', text: `Memory ${id} not found.` }], isError: true };
      }

      let embedding;
      if (content !== undefined) {
        embedding = await generateEmbedding(content);
      }

      const updated = await updateMemory(id, content, metadata, tags, embedding);
      return {
        content: [{ type: 'text', text: `Updated memory ${updated.id}:\n${updated.content}` }],
      };
    }
  );

  // --- Tool: memory_delete ---
  server.tool(
    'memory_delete',
    'Delete a memory by ID.',
    {
      id: z.string().uuid().describe('Memory UUID to delete'),
    },
    async ({ id }) => {
      const deleted = await deleteMemory(id);
      if (!deleted) {
        return { content: [{ type: 'text', text: `Memory ${id} not found.` }], isError: true };
      }
      return { content: [{ type: 'text', text: `Deleted memory ${id}.` }] };
    }
  );

  // --- Tool: memory_list ---
  server.tool(
    'memory_list',
    'List stored memories, optionally filtered by tags.',
    {
      tags: z.array(z.string()).optional().describe('Filter by tags'),
      limit: z.number().optional().default(20).describe('Maximum results (default: 20)'),
      offset: z.number().optional().default(0).describe('Offset for pagination'),
    },
    async ({ tags, limit, offset }) => {
      const results = await listMemories({ tags, limit, offset });

      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No memories found.' }] };
      }

      const formatted = results.map((r, i) =>
        `[${offset + i + 1}] ${r.content}` +
        (r.tags.length ? `\n    Tags: ${r.tags.join(', ')}` : '') +
        `\n    ID: ${r.id} | Created: ${r.created_at.toISOString()}`
      ).join('\n\n');

      return { content: [{ type: 'text', text: formatted }] };
    }
  );

  // --- Tool: memory_stats ---
  server.tool(
    'memory_stats',
    'Show memory database statistics.',
    {},
    async () => {
      const stats = await getStats();
      const text = [
        `Total memories: ${stats.total_memories}`,
        `Unique tags: ${stats.unique_tags}`,
        `Oldest: ${stats.oldest_memory || 'n/a'}`,
        `Newest: ${stats.newest_memory || 'n/a'}`,
      ].join('\n');
      return { content: [{ type: 'text', text }] };
    }
  );

  return server;
}

// --- Express app with SSE + Streamable HTTP transports ---

const app = express();

// Trust first proxy for rate limiting (set to 0 to disable)
app.set('trust proxy', parseInt(process.env.TRUST_PROXY || '0'));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Auth (OAuth 2.1 routes + consent page, if MCP_AUTH_PIN is set)
initAuth(app);

// Auth middleware for MCP endpoints
const auth = authMiddleware();

// Health check (no auth required)
app.get('/health', async (_req, res) => {
  try {
    const stats = await getStats();
    res.json({
      status: 'ok',
      version: '0.2.0',
      model: process.env.EMBEDDINGS_MODEL || 'unknown',
      memories: parseInt(stats.total_memories),
      sessions: sessions.size + httpSessions.size,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// --- Streamable HTTP transport (POST /mcp) ---
app.post('/mcp', auth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId && httpSessions.has(sessionId)) {
    const session = httpSessions.get(sessionId);
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  // New session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = createMcpServer();

  await server.connect(transport);

  const newSessionId = transport.sessionId;
  if (newSessionId) {
    httpSessions.set(newSessionId, { server, transport });
  }

  await transport.handleRequest(req, res, req.body);
});

// Handle GET /mcp for SSE stream (Streamable HTTP spec)
app.get('/mcp', auth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !httpSessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }
  const session = httpSessions.get(sessionId);
  await session.transport.handleRequest(req, res, req.body);
});

// Handle DELETE /mcp for session cleanup
app.delete('/mcp', auth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && httpSessions.has(sessionId)) {
    const session = httpSessions.get(sessionId);
    await session.server.close();
    httpSessions.delete(sessionId);
  }
  res.status(200).end();
});

// --- Legacy SSE transport (GET /sse + POST /messages) ---
app.get('/sse', auth, async (req, res) => {
  console.log('New SSE connection');
  const transport = new SSEServerTransport('/messages', res);
  const server = createMcpServer();

  sessions.set(transport.sessionId, { server, transport });

  res.on('close', () => {
    console.log(`SSE session ${transport.sessionId} closed`);
    sessions.delete(transport.sessionId);
    server.close();
  });

  await server.connect(transport);
});

app.post('/messages', auth, async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    res.status(404).json({ error: 'Session not found', sessionId });
    return;
  }

  await session.transport.handlePostMessage(req, res);
});

// --- Startup ---

async function main() {
  console.log('mcp-recall starting...');

  await runMigrations();
  console.log('Database ready');

  await initEmbeddings();
  console.log('Embeddings ready');

  app.listen(PORT, HOST, () => {
    console.log(`mcp-recall listening on http://${HOST}:${PORT}`);
    console.log(`Streamable HTTP: http://${HOST}:${PORT}/mcp`);
    console.log(`SSE endpoint:    http://${HOST}:${PORT}/sse`);
    console.log(`Health check:    http://${HOST}:${PORT}/health`);
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  for (const { server } of sessions.values()) {
    await server.close();
  }
  for (const { server } of httpSessions.values()) {
    await server.close();
  }
  await closePool();
  process.exit(0);
});

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
