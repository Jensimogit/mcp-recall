#!/usr/bin/env node
/**
 * Model switch script for mcp-recall.
 * 
 * Switches embedding model, migrates DB dimensions if needed,
 * re-embeds all memories, and restarts the server.
 *
 * Usage: node scripts/switch-model.js <model-name> [--dry-run] [--benchmark-only]
 *
 * Available models (in ./models/):
 *   multilingual-e5-large      (1024d, 100+ languages, IR optimized — recommended)
 *   bge-m3                     (1024d, 100+ languages, state-of-the-art IR)
 *   all-MiniLM-L6-v2           (384d, lightweight, English-focused)
 */

import pg from 'pg';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

// Model registry — add your own models here
const MODELS = {
  'multilingual-e5-large':     { dims: 1024, pooling: 'mean', desc: '100+ languages, IR optimized (recommended)' },
  'bge-m3':                    { dims: 1024, pooling: 'cls',  desc: 'State-of-the-art multilingual IR' },
  'all-MiniLM-L6-v2':         { dims: 384,  pooling: 'mean', desc: 'Lightweight, English-focused' },
};

// Benchmark queries — edit these to match your actual memories
const BENCHMARK_QUERIES = [
  { query: 'database backup configuration', expect: 'backup' },
  { query: 'SSH connection problem', expect: 'SSH' },
  { query: 'Docker container networking', expect: 'docker' },
  { query: 'how to deploy the application', expect: 'deploy' },
  { query: 'server monitoring setup', expect: 'monitoring' },
  { query: 'user authentication flow', expect: 'auth' },
];

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const benchmarkOnly = args.includes('--benchmark-only');
  const modelName = args.find(a => !a.startsWith('--'));

  if (!modelName || !MODELS[modelName]) {
    console.log('Usage: node scripts/switch-model.js <model-name> [--dry-run] [--benchmark-only]');
    console.log('\nAvailable models:');
    for (const [name, info] of Object.entries(MODELS)) {
      console.log(`  ${name.padEnd(30)} ${info.dims}d  ${info.desc}`);
    }
    process.exit(1);
  }

  const model = MODELS[modelName];
  const modelPath = join(PROJECT_DIR, 'models', modelName);

  if (!existsSync(modelPath)) {
    console.error(`Model not found: ${modelPath}`);
    process.exit(1);
  }

  console.log(`\n=== Model: ${modelName} (${model.dims}d) ===\n`);

  // Load embedding pipeline
  const { pipeline: createPipeline, env } = await import('@xenova/transformers');
  env.localModelPath = join(PROJECT_DIR, 'models') + '/';
  env.allowRemoteModels = false;

  console.log('Loading model...');
  const pipe = await createPipeline('feature-extraction', modelName, { quantized: true });
  console.log('Model loaded.\n');

  async function embed(text) {
    const out = await pipe(text, { pooling: model.pooling, normalize: true });
    return Array.from(out.data);
  }

  // --- Benchmark ---
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  // Get current DB dimension
  const { rows: [dimRow] } = await pool.query(
    "SELECT atttypmod FROM pg_attribute WHERE attrelid = 'memories'::regclass AND attname = 'embedding'"
  );
  const currentDims = dimRow.atttypmod;

  console.log(`DB dimensions: ${currentDims}, Model dimensions: ${model.dims}`);
  const needsMigration = currentDims !== model.dims;

  if (needsMigration) {
    console.log(`>>> DB migration needed: vector(${currentDims}) → vector(${model.dims})\n`);
  }

  if (benchmarkOnly) {
    // Benchmark against raw text similarity (no DB queries)
    console.log('--- Benchmark (offline, text similarity) ---\n');
    
    // Fetch some memories for comparison
    const { rows: memories } = await pool.query('SELECT id, content FROM memories ORDER BY created_at LIMIT 50');
    const memEmbeddings = [];
    for (const m of memories) {
      memEmbeddings.push({ id: m.id, content: m.content, embedding: await embed(m.content) });
    }

    function cosine(a, b) {
      let dot = 0;
      for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
      return dot;
    }

    for (const bq of BENCHMARK_QUERIES) {
      const qEmb = await embed(bq.query);
      const scored = memEmbeddings.map(m => ({
        similarity: cosine(qEmb, m.embedding),
        content: m.content.substring(0, 80),
      })).sort((a, b) => b.similarity - a.similarity);

      console.log(`Query: "${bq.query}"`);
      for (let i = 0; i < 3; i++) {
        console.log(`  [${i+1}] ${(scored[i].similarity * 100).toFixed(1)}%  ${scored[i].content}...`);
      }
      console.log();
    }

    await pool.end();
    console.log('Benchmark done. No changes made.');
    return;
  }

  if (dryRun) {
    console.log('Dry run — no changes will be made.');
    console.log(`Would: ${needsMigration ? `migrate vector(${currentDims}) → vector(${model.dims}), ` : ''}re-embed all memories, update .env`);
    await pool.end();
    return;
  }

  // --- Full switch ---
  console.log('Switching model...\n');

  // 1. Migrate DB if dimensions changed
  if (needsMigration) {
    console.log(`Migrating: vector(${currentDims}) → vector(${model.dims})...`);
    await pool.query('ALTER TABLE memories ALTER COLUMN embedding DROP NOT NULL');
    await pool.query('UPDATE memories SET embedding = NULL');
    await pool.query('DROP INDEX IF EXISTS idx_memories_embedding');
    await pool.query(`ALTER TABLE memories ALTER COLUMN embedding TYPE vector(${model.dims})`);
    await pool.query('CREATE INDEX idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops)');
    console.log('DB migration done.\n');
  }

  // 2. Re-embed all memories
  const { rows } = await pool.query('SELECT id, content FROM memories ORDER BY created_at');
  console.log(`Re-embedding ${rows.length} memories...`);
  
  const startTime = Date.now();
  let done = 0;
  for (const row of rows) {
    const embedding = await embed(row.content);
    await pool.query(
      'UPDATE memories SET embedding = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(embedding), row.id]
    );
    done++;
    if (done % 25 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (done / (Date.now() - startTime) * 1000).toFixed(1);
      console.log(`  ${done}/${rows.length}  (${elapsed}s, ${rate}/s)`);
    }
  }
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Re-embedded ${done} memories in ${totalTime}s.\n`);

  // 3. Restore NOT NULL
  if (needsMigration) {
    await pool.query('ALTER TABLE memories ALTER COLUMN embedding SET NOT NULL');
  }

  // 4. Update .env
  const envPath = join(PROJECT_DIR, '.env');
  let envContent = '';
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, 'utf-8');
  }
  if (envContent.includes('EMBEDDINGS_MODEL=')) {
    envContent = envContent.replace(/EMBEDDINGS_MODEL=.*/g, `EMBEDDINGS_MODEL=${modelName}`);
  } else {
    envContent += `\nEMBEDDINGS_MODEL=${modelName}\n`;
  }
  writeFileSync(envPath, envContent);
  console.log(`.env updated: EMBEDDINGS_MODEL=${modelName}`);

  // 5. Update migration SQL
  const initSql = join(PROJECT_DIR, 'migrations', '001_init.sql');
  if (existsSync(initSql)) {
    let sql = readFileSync(initSql, 'utf-8');
    sql = sql.replace(/vector\(\d+\)/, `vector(${model.dims})`);
    writeFileSync(initSql, sql);
    console.log(`001_init.sql updated: vector(${model.dims})`);
  }

  // 6. Verify
  const { rows: [verify] } = await pool.query(
    "SELECT count(*) as total, vector_dims(embedding) as dims FROM memories WHERE embedding IS NOT NULL GROUP BY vector_dims(embedding)"
  );
  console.log(`\nVerification: ${verify.total} memories, ${verify.dims} dimensions`);

  await pool.end();
  console.log(`\n=== Switch complete: ${modelName} (${model.dims}d) ===`);
  console.log('Restart server: docker compose restart mcp-recall');
}

main().catch(err => { console.error(err); process.exit(1); });
