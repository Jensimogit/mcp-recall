# mcp-recall

A self-hosted [MCP](https://modelcontextprotocol.io/) memory server that gives AI assistants persistent, semantic memory. Store facts, search by meaning, swap embedding models — all running locally on your own hardware.

**No cloud APIs. No GPU required. No API costs.**

```
You: "What do we know about the backup configuration?"
Claude: memory_search → finds relevant memories in milliseconds
```

## What it does

mcp-recall stores memories as vector embeddings in PostgreSQL and makes them searchable via the Model Context Protocol. Your AI assistant can remember things across sessions, projects, and devices.

| Feature | Details |
|---------|---------|
| **Semantic search** | Find memories by meaning, not keywords |
| **Swappable models** | Change embedding models without losing data |
| **Built-in benchmarking** | Compare models against your actual data |
| **Dual transport** | Streamable HTTP + SSE (legacy) |
| **Local embeddings** | ONNX models run in-process, no external calls |
| **Low resource** | Runs on a Celeron J1900 with 16 GB RAM |

## Quick start

### 1. Clone and configure

```bash
git clone https://github.com/Jensimogit/mcp-recall.git
cd mcp-recall
npm install
cp .env.example .env
# Generate a random database password (you'll never need to type it)
echo "POSTGRES_PASSWORD=$(openssl rand -base64 32)" >> .env
```

### 2. Download an embedding model

Models are not included in the repository (they're 170–560 MB). Download one:

```bash
node scripts/download-model.js multilingual-e5-large
```

Verify the model files are in place:

```bash
ls models/multilingual-e5-large/
# Expected: config.json  onnx/  tokenizer.json  tokenizer_config.json
```

If the directory is empty (rare, depends on cache layout), copy manually:

```bash
find node_modules/@xenova/transformers/.cache -name "config.json"
# Copy the directory that contains config.json + tokenizer.json:
cp -r node_modules/@xenova/transformers/.cache/Xenova/multilingual-e5-large/* models/multilingual-e5-large/
```

### 3. Start the server

```bash
docker compose up -d
```

That's it. The server starts, runs the database migration, loads the embedding model, and listens on port 3000.

```bash
# Verify it's running
curl http://localhost:3000/health
# {"status":"ok","version":"0.2.0","model":"multilingual-e5-large","memories":0,"sessions":0}
```

### 4. Seed example memories (optional)

Load some example memories to verify search works and to run benchmarks:

```bash
docker compose run --rm mcp-recall node scripts/seed-examples.js
```

This stores 10 memories about mcp-recall itself. You can search them immediately:

```bash
# Quick test via the health endpoint — should show memories: 10
curl http://localhost:3000/health
```

### 5. Connect your AI assistant

**Claude Code:**
```bash
claude mcp add -s user --transport http mcp-recall http://localhost:3000/mcp
```

**Claude Code (SSE transport):**
```bash
claude mcp add -s user --transport sse mcp-recall http://localhost:3000/sse
```

**Other MCP clients** — point them to `http://localhost:3000/mcp` (Streamable HTTP) or `http://localhost:3000/sse` (SSE).

### 6. Verify it works

Start a new Claude Code session and try the tools:

```
$ claude

You: Use memory_stats to check the database

Claude: ✓ memory_stats → {"total_memories": 10, ...}

You: Search memories for "backup"

Claude: ✓ memory_search → finds "Database backup: docker exec mcp-recall-db pg_dump ..."

You: Store a new memory: "The deploy key is in 1Password under 'production-deploy'"

Claude: ✓ memory_store → stored with auto-generated embedding

You: Search for "deploy credentials"

Claude: ✓ memory_search → finds the memory you just stored
```

If the tools show up and return results, you're all set.

## Architecture

```
┌─────────────────────────────────────────────┐
│  MCP Client (Claude Code, claude.ai, etc.)  │
└─────────────────┬───────────────────────────┘
                  │  HTTP (Streamable HTTP or SSE)
                  ▼
┌─────────────────────────────────────────────┐
│  mcp-recall-server (Node.js 22)             │
│  ├── MCP Protocol (6 tools)                 │
│  ├── Express HTTP                           │
│  └── @xenova/transformers (ONNX, local)     │
│       └── Embedding model (volume mount)    │
└─────────────────┬───────────────────────────┘
                  │
┌─────────────────▼───────────────────────────┐
│  PostgreSQL 16 + pgvector                   │
│  └── HNSW index (cosine similarity)         │
└─────────────────────────────────────────────┘
```

All components run in Docker. The embedding model runs directly in the Node.js process using ONNX Runtime — no Ollama, no Python, no separate inference server.

## MCP Tools

Your AI assistant gets these tools:

| Tool | Description |
|------|-------------|
| `memory_store` | Store a new memory (auto-generates embedding) |
| `memory_search` | Search by semantic similarity |
| `memory_update` | Update content, tags, or metadata (re-embeds if content changes) |
| `memory_delete` | Delete a memory by ID |
| `memory_list` | List memories, optionally filtered by tags |
| `memory_stats` | Show database statistics |

## Embedding models

### Recommended: multilingual-e5-large (1024d)

This is the default and recommended model. It's trained specifically for **information retrieval** (short query → long text), which is exactly how memory search works.

### Available models

| Model | Dimensions | Size (quantized) | Best for |
|-------|-----------|-------------------|----------|
| `multilingual-e5-large` | 1024 | ~553 MB | **General use (recommended)** |
| `bge-m3` | 1024 | ~560 MB | Multi-granular retrieval |
| `all-MiniLM-L6-v2` | 384 | ~22 MB | Minimal resources, English-only |

You can use any ONNX model compatible with `@xenova/transformers`. Just place it in `models/<name>/` with the standard HuggingFace file structure.

### Benchmark results

We tested three models against 201 real memories with 8 search queries:

| Model | Correct top-1 | Avg similarity | Speed |
|-------|--------------|----------------|-------|
| multilingual-e5-large | **8/8 (100%)** | **85.0%** | 0.1/s* |
| bge-m3 | 8/8 (100%) | 61.3% | 0.1/s* |
| cross-en-de-roberta | 2/8 (25%) | 35.3% | 0.5/s* |

\* Embedding speed on Intel Celeron J1900. Much faster on modern CPUs.

**Key finding:** Models trained for information retrieval (e5, bge) dramatically outperform sentence-similarity models (roberta) for memory search, regardless of language specialization.

### Switching models

```bash
# Compare models against your data (read-only, no changes)
docker compose run --rm mcp-recall node scripts/benchmark-models.js multilingual-e5-large

# Switch to a different model (migrates DB, re-embeds everything)
docker compose run --rm mcp-recall node scripts/switch-model.js bge-m3

# Restart the server to use the new model
docker compose restart mcp-recall
```

The switch script handles everything:
- Detects dimension changes and migrates the database
- Re-embeds all memories with the new model
- Updates the `.env` file
- Verifies the result

**Your text data is never lost.** Only the vector embeddings are regenerated. Content, tags, and metadata remain untouched in PostgreSQL.

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_PASSWORD` | (required) | Database password |
| `EMBEDDINGS_MODEL` | `multilingual-e5-large` | Model directory name in `./models/` |
| `MCP_PORT` | `3000` | Server port |
| `TRUST_PROXY` | `0` | Proxy trust level (set to `1` behind nginx/Caddy) |

### Behind a reverse proxy

If you run mcp-recall behind a reverse proxy (nginx, Caddy, Traefik):

1. Set `TRUST_PROXY=1` in `.env`
2. Proxy to `http://localhost:3000`
3. For Streamable HTTP: proxy `POST/GET/DELETE /mcp`
4. For SSE: proxy `GET /sse` and `POST /messages`

## Resource usage

Measured on an Intel Celeron J1900 (4 cores @ 2.0 GHz) with 16 GB RAM:

| Component | RAM | CPU (idle) | Disk |
|-----------|-----|-----------|------|
| mcp-recall-server | ~1.1 GB | 0% | ~50 MB (image) |
| PostgreSQL + pgvector | ~26 MB | 0% | ~20 MB (200 memories) |
| **Total** | **~1.1 GB** | **0%** | - |
| Embedding model (on disk) | - | - | 553 MB (e5-large) |

- Memory usage is dominated by the ONNX model loaded into RAM
- CPU spikes only during embedding generation (~100–200ms per query)
- Re-embedding 200 memories takes ~30 minutes on the Celeron, much less on modern hardware

## Project structure

```
mcp-recall/
├── compose.yml             # Docker Compose (2 services)
├── Dockerfile              # Server image (node:22-slim)
├── .env.example            # Configuration template
├── package.json            # 5 dependencies
├── models/                 # Embedding models (git-ignored, volume-mounted)
│   └── multilingual-e5-large/
│       ├── config.json
│       ├── tokenizer.json
│       ├── tokenizer_config.json
│       └── onnx/model_quantized.onnx
├── migrations/
│   └── 001_init.sql        # Schema: memories table + HNSW index
├── scripts/
│   ├── switch-model.js     # Switch models with DB migration + re-embedding
│   ├── benchmark-models.js # A/B compare models against your data
│   ├── download-model.js   # Download models from Hugging Face
│   └── seed-examples.js    # Load example memories for testing
└── src/
    ├── index.js            # MCP server, Express, dual transport (308 lines)
    ├── database.js         # PostgreSQL CRUD operations (158 lines)
    ├── embeddings.js       # Model-agnostic embedding engine (42 lines)
    └── migrate.js          # Standalone migration runner (16 lines)
```

~970 lines of code total. No framework overhead, no unnecessary abstractions.

## Database

The schema is simple — one table:

```sql
CREATE TABLE memories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content     TEXT NOT NULL,
    metadata    JSONB DEFAULT '{}',
    tags        TEXT[] DEFAULT '{}',
    embedding   vector(1024) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```

Indexes: HNSW (cosine similarity on embeddings), GIN (tag filtering), B-tree (created_at).

### Backup

```bash
# Dump the database
docker exec mcp-recall-db pg_dump -U mcp mcp_recall > backup.sql

# Restore
cat backup.sql | docker exec -i mcp-recall-db psql -U mcp mcp_recall
```

## FAQ

**Q: Do I need a GPU?**
No. The embedding model runs on CPU via ONNX Runtime. It works fine on low-power hardware like a Celeron J1900. Embedding generation takes ~100–200ms per query — imperceptible during normal use.

**Q: How many memories can it handle?**
The HNSW index works efficiently up to tens of thousands of entries. At that scale, consider IVFFlat indexing instead.

**Q: Can I use it with ChatGPT / other LLMs?**
Yes — any MCP-compatible client works. The server implements the standard Model Context Protocol.

**Q: What happens if I switch models?**
Your text data (content, tags, metadata) is preserved. Only the vector embeddings are regenerated. The `switch-model.js` script handles the entire process, including database dimension changes.

**Q: Is my data sent anywhere?**
No. Embeddings are generated locally. The server has no outbound connections. Your data stays on your hardware. However, when an MCP client retrieves memories, the content flows to whatever LLM provider the client uses.

## Dependencies and licenses

| Package | License | Purpose |
|---------|---------|---------|
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | MCP protocol implementation |
| [@xenova/transformers](https://github.com/huggingface/transformers.js) | Apache-2.0 | ONNX Runtime for embeddings |
| [express](https://github.com/expressjs/express) | MIT | HTTP server |
| [pg](https://github.com/brianc/node-postgres) | MIT | PostgreSQL client |
| [zod](https://github.com/colinhacks/zod) | MIT | Schema validation |
| [pgvector](https://github.com/pgvector/pgvector) | PostgreSQL License | Vector similarity search |

All dependencies are permissively licensed (MIT or Apache-2.0).

## Contributing

Contributions are welcome! This project values simplicity — please keep changes focused and minimal.

## License

[MIT](LICENSE)
