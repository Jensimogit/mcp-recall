/**
 * Offline benchmark: Compare all available models against the same memories.
 * Runs inside Docker or with DATABASE_URL set.
 */
import pg from 'pg';

// Add your own models here — must exist in ./models/
const MODELS = {
  'multilingual-e5-large':     { dims: 1024, pooling: 'mean' },
  'bge-m3':                    { dims: 1024, pooling: 'cls'  },
  'all-MiniLM-L6-v2':         { dims: 384,  pooling: 'mean' },
};

// Edit these queries to match your actual memories for meaningful benchmarks.
// Good queries test both short→long retrieval and cross-lingual search.
const QUERIES = [
  'database backup configuration',
  'SSH connection problem',
  'Docker container networking',
  'how to deploy the application',
  'server monitoring setup',
  'user authentication flow',
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function benchmarkModel(modelName, modelConf) {
  const { pipeline: createPipeline, env } = await import('@xenova/transformers');
  env.localModelPath = process.env.LOCAL_MODEL_PATH || '/app/models/';
  env.allowRemoteModels = false;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`MODEL: ${modelName} (${modelConf.dims}d, pooling: ${modelConf.pooling})`);
  console.log('='.repeat(60));

  const pipe = await createPipeline('feature-extraction', modelName, { quantized: true });

  async function embed(text) {
    const out = await pipe(text, { pooling: modelConf.pooling, normalize: true });
    return Array.from(out.data);
  }

  function cosine(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }

  // Embed all memories
  const { rows: memories } = await pool.query('SELECT id, content FROM memories ORDER BY created_at');
  console.log(`Embedding ${memories.length} memories...`);
  const t0 = Date.now();
  const memEmbeddings = [];
  for (const m of memories) {
    memEmbeddings.push({ content: m.content, embedding: await embed(m.content) });
  }
  const embedTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Done in ${embedTime}s (${(memories.length / (Date.now() - t0) * 1000).toFixed(1)}/s)\n`);

  if (memories.length === 0) {
    console.log('No memories found. Store some memories first, then run the benchmark again.\n');
    pipe.dispose?.();
    return;
  }

  // Run queries
  for (const query of QUERIES) {
    const qEmb = await embed(query);
    const scored = memEmbeddings.map(m => ({
      similarity: cosine(qEmb, m.embedding),
      content: m.content.substring(0, 90).replace(/\n/g, ' '),
    })).sort((a, b) => b.similarity - a.similarity);

    console.log(`"${query}"`);
    for (let i = 0; i < 3; i++) {
      const s = scored[i];
      const bar = '#'.repeat(Math.round(s.similarity * 40));
      console.log(`  [${i+1}] ${(s.similarity * 100).toFixed(1).padStart(5)}%  ${bar}`);
      console.log(`       ${s.content}...`);
    }
    console.log();
  }

  // Cleanup pipeline to free memory
  pipe.dispose?.();
}

async function main() {
  const modelFilter = process.argv[2]; // optional: run only one model
  
  for (const [name, conf] of Object.entries(MODELS)) {
    if (modelFilter && name !== modelFilter) continue;
    try {
      await benchmarkModel(name, conf);
    } catch (err) {
      if (err.message?.includes('not found locally')) {
        console.log(`\nSkipping ${name} — model not downloaded.`);
        console.log(`Download it first: node scripts/download-model.js ${name}\n`);
      } else {
        throw err;
      }
    }
  }

  await pool.end();
  console.log('\n=== Benchmark complete ===');
}

main().catch(err => { console.error(err); process.exit(1); });
