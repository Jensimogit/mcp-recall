-- mcp-recall: Initial schema
-- Safe to run multiple times (IF NOT EXISTS everywhere)

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS memories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content     TEXT NOT NULL,
    metadata    JSONB DEFAULT '{}',
    tags        TEXT[] DEFAULT '{}',
    embedding   vector(1024) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW index for cosine similarity search (better than IVFFlat for <10k entries)
CREATE INDEX IF NOT EXISTS idx_memories_embedding
    ON memories USING hnsw (embedding vector_cosine_ops);

-- GIN index for tag filtering
CREATE INDEX IF NOT EXISTS idx_memories_tags
    ON memories USING gin (tags);

-- Sort by recency
CREATE INDEX IF NOT EXISTS idx_memories_created_at
    ON memories (created_at DESC);
