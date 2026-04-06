/**
 * PostgreSQL + pgvector database operations for memory storage.
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: parseInt(process.env.DB_MAX_POOL_SIZE || '10'),
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
    });
  }
  return pool;
}

export async function runMigrations() {
  const client = await getPool().connect();
  try {
    const sql = readFileSync(
      join(__dirname, '..', 'migrations', '001_init.sql'),
      'utf-8'
    );
    await client.query(sql);
    console.log('Database migrations applied');
  } finally {
    client.release();
  }
}

export async function createMemory(content, metadata, tags, embedding) {
  const { rows } = await getPool().query(
    `INSERT INTO memories (content, metadata, tags, embedding)
     VALUES ($1, $2, $3, $4)
     RETURNING id, content, metadata, tags, created_at`,
    [content, JSON.stringify(metadata || {}), tags || [], JSON.stringify(embedding)]
  );
  return rows[0];
}

export async function searchMemories(embedding, { tags, limit = 10 } = {}) {
  let query = `
    SELECT id, content, metadata, tags, created_at, updated_at,
           1 - (embedding <=> $1) AS similarity
    FROM memories
  `;
  const params = [JSON.stringify(embedding)];
  let paramIdx = 2;

  if (tags && tags.length > 0) {
    query += ` WHERE tags && $${paramIdx}`;
    params.push(tags);
    paramIdx++;
  }

  query += ` ORDER BY embedding <=> $1 LIMIT $${paramIdx}`;
  params.push(limit);

  const { rows } = await getPool().query(query, params);
  return rows;
}

export async function listMemories({ tags, limit = 50, offset = 0 } = {}) {
  let query = 'SELECT id, content, metadata, tags, created_at, updated_at FROM memories';
  const params = [];
  let paramIdx = 1;

  if (tags && tags.length > 0) {
    query += ` WHERE tags && $${paramIdx}`;
    params.push(tags);
    paramIdx++;
  }

  query += ` ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
  params.push(limit, offset);

  const { rows } = await getPool().query(query, params);
  return rows;
}

export async function getMemory(id) {
  const { rows } = await getPool().query(
    'SELECT id, content, metadata, tags, created_at, updated_at FROM memories WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

export async function updateMemory(id, content, metadata, tags, embedding) {
  const setClauses = ['updated_at = NOW()'];
  const params = [];
  let paramIdx = 1;

  if (content !== undefined) {
    setClauses.push(`content = $${paramIdx}`);
    params.push(content);
    paramIdx++;
  }
  if (metadata !== undefined) {
    setClauses.push(`metadata = $${paramIdx}`);
    params.push(JSON.stringify(metadata));
    paramIdx++;
  }
  if (tags !== undefined) {
    setClauses.push(`tags = $${paramIdx}`);
    params.push(tags);
    paramIdx++;
  }
  if (embedding !== undefined) {
    setClauses.push(`embedding = $${paramIdx}`);
    params.push(JSON.stringify(embedding));
    paramIdx++;
  }

  params.push(id);

  const { rows } = await getPool().query(
    `UPDATE memories SET ${setClauses.join(', ')} WHERE id = $${paramIdx}
     RETURNING id, content, metadata, tags, created_at, updated_at`,
    params
  );
  return rows[0] || null;
}

export async function deleteMemory(id) {
  const { rowCount } = await getPool().query(
    'DELETE FROM memories WHERE id = $1',
    [id]
  );
  return rowCount > 0;
}

export async function getStats() {
  const { rows } = await getPool().query(`
    SELECT
      COUNT(DISTINCT id) AS total_memories,
      COUNT(DISTINCT unnest_tags) AS unique_tags,
      MIN(created_at) AS oldest_memory,
      MAX(created_at) AS newest_memory
    FROM memories, LATERAL unnest(COALESCE(NULLIF(tags, '{}'), ARRAY[NULL::text])) AS unnest_tags
  `);
  return rows[0];
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
