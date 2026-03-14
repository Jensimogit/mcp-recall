/**
 * Local embedding generation using Xenova/transformers (ONNX Runtime).
 * Supports multiple models via EMBEDDINGS_MODEL env var.
 * No external API calls — runs entirely on CPU.
 */

let pipeline = null;

const MODEL = process.env.EMBEDDINGS_MODEL || 'multilingual-e5-large';
const LOCAL_MODEL_PATH = process.env.LOCAL_MODEL_PATH || '/app/models/';

// Model-specific pooling strategy
const POOLING = {
  'cross-en-de-roberta-final': 'mean',
  'multilingual-e5-large': 'mean',
  'bge-m3': 'cls',
};

const pooling = POOLING[MODEL] || 'mean';

export async function initEmbeddings() {
  if (pipeline) return;
  const { pipeline: createPipeline, env } = await import('@xenova/transformers');

  env.localModelPath = LOCAL_MODEL_PATH;
  env.allowRemoteModels = false;

  console.log(`Loading embedding model: ${MODEL} (pooling: ${pooling})`);
  pipeline = await createPipeline('feature-extraction', MODEL, {
    quantized: true,
  });

  // Detect dimensions from a test embedding
  const test = await pipeline('test', { pooling, normalize: true });
  console.log(`Embedding model loaded: ${test.data.length}d`);
}

export async function generateEmbedding(text) {
  if (!pipeline) await initEmbeddings();
  const output = await pipeline(text, { pooling, normalize: true });
  return Array.from(output.data);
}
