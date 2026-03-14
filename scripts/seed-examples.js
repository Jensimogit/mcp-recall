#!/usr/bin/env node
/**
 * Seed the database with example memories for testing and benchmarking.
 * Safe to run multiple times — skips if memories already exist.
 *
 * Usage: docker compose run --rm mcp-recall node scripts/seed-examples.js
 */

import pg from 'pg';

const EXAMPLES = [
  {
    content: 'mcp-recall uses PostgreSQL with pgvector for semantic search. Memories are stored as vector embeddings using HNSW indexing with cosine similarity.',
    tags: ['architecture', 'database'],
  },
  {
    content: 'The default embedding model is multilingual-e5-large (1024 dimensions). It supports 100+ languages and is optimized for information retrieval — short queries matching longer text passages.',
    tags: ['embeddings', 'model'],
  },
  {
    content: 'Embedding models run locally via ONNX Runtime inside the Node.js process. No GPU required, no external API calls. Works on low-power hardware like Intel Celeron.',
    tags: ['embeddings', 'performance'],
  },
  {
    content: 'To switch embedding models, use: node scripts/switch-model.js <model-name>. The script migrates database dimensions, re-embeds all memories, and updates the configuration. Text data is never lost.',
    tags: ['operations', 'model'],
  },
  {
    content: 'mcp-recall supports two MCP transports: Streamable HTTP (POST/GET/DELETE /mcp) and SSE legacy (GET /sse + POST /messages). Streamable HTTP is recommended for new setups.',
    tags: ['architecture', 'transport'],
  },
  {
    content: 'The server exposes 6 MCP tools: memory_store, memory_search, memory_update, memory_delete, memory_list, and memory_stats. AI assistants use these to manage persistent memory across sessions.',
    tags: ['api', 'tools'],
  },
  {
    content: 'Docker Compose runs two containers: mcp-recall (Node.js 22) and PostgreSQL 16 with pgvector. Models are mounted as a read-only volume from the host at ./models:/app/models:ro.',
    tags: ['deployment', 'docker'],
  },
  {
    content: 'Database backup: docker exec mcp-recall-db pg_dump -U mcp mcp_recall > backup.sql. Restore: cat backup.sql | docker exec -i mcp-recall-db psql -U mcp mcp_recall.',
    tags: ['operations', 'backup'],
  },
  {
    content: 'When running behind a reverse proxy (nginx, Caddy, Traefik), set TRUST_PROXY=1 in .env. For SSE transport, make sure the proxy does not buffer server-sent events.',
    tags: ['deployment', 'proxy'],
  },
  {
    content: 'Resource usage on Intel Celeron J1900: ~1.1 GB RAM (mostly the ONNX model), 0% CPU at idle, ~100-200ms per embedding query. Re-embedding 200 memories takes about 30 minutes.',
    tags: ['performance', 'resources'],
  },
];

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const { rows: [{ count }] } = await pool.query('SELECT count(*) FROM memories');
  if (parseInt(count) > 0) {
    console.log(`Database already has ${count} memories. Skipping seed.`);
    console.log('To re-seed, delete existing memories first.');
    await pool.end();
    return;
  }

  // Load embedding engine
  const { pipeline: createPipeline, env } = await import('@xenova/transformers');
  env.localModelPath = process.env.LOCAL_MODEL_PATH || '/app/models/';
  env.allowRemoteModels = false;

  const model = process.env.EMBEDDINGS_MODEL || 'multilingual-e5-large';
  const POOLING = {
    'multilingual-e5-large': 'mean',
    'bge-m3': 'cls',
    'all-MiniLM-L6-v2': 'mean',
  };

  console.log(`Loading model: ${model}...`);
  const pipe = await createPipeline('feature-extraction', model, { quantized: true });

  async function embed(text) {
    const out = await pipe(text, { pooling: POOLING[model] || 'mean', normalize: true });
    return Array.from(out.data);
  }

  console.log(`Storing ${EXAMPLES.length} example memories...\n`);

  for (const ex of EXAMPLES) {
    const embedding = await embed(ex.content);
    await pool.query(
      'INSERT INTO memories (content, tags, embedding) VALUES ($1, $2, $3)',
      [ex.content, ex.tags, JSON.stringify(embedding)]
    );
    console.log(`  [${ex.tags.join(', ')}] ${ex.content.substring(0, 70)}...`);
  }

  console.log(`\nDone. ${EXAMPLES.length} memories stored.`);
  console.log('Try: docker compose run --rm mcp-recall node scripts/benchmark-models.js');

  pipe.dispose?.();
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
