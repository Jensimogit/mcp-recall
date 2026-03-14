#!/usr/bin/env node
/**
 * Download an embedding model from Hugging Face for use with mcp-recall.
 *
 * Usage: node scripts/download-model.js <model-name>
 *
 * Supported models:
 *   multilingual-e5-large  (1024d, recommended)
 *   bge-m3                 (1024d, alternative)
 *   all-MiniLM-L6-v2       (384d, lightweight)
 */

import { existsSync, mkdirSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

const MODELS = {
  'multilingual-e5-large': {
    hf: 'Xenova/multilingual-e5-large',
    dims: 1024,
    desc: 'Recommended — 100+ languages, optimized for information retrieval',
  },
  'bge-m3': {
    hf: 'Xenova/bge-m3',
    dims: 1024,
    desc: 'State-of-the-art multilingual retrieval',
  },
  'all-MiniLM-L6-v2': {
    hf: 'Xenova/all-MiniLM-L6-v2',
    dims: 384,
    desc: 'Lightweight, English-focused (~22 MB)',
  },
};

async function main() {
  const modelName = process.argv[2];

  if (!modelName || !MODELS[modelName]) {
    console.log('Usage: node scripts/download-model.js <model-name>\n');
    console.log('Available models:');
    for (const [name, info] of Object.entries(MODELS)) {
      console.log(`  ${name.padEnd(28)} ${info.dims}d  ${info.desc}`);
    }
    process.exit(1);
  }

  const model = MODELS[modelName];
  const targetDir = join(PROJECT_DIR, 'models', modelName);

  if (existsSync(join(targetDir, 'config.json'))) {
    console.log(`Model already exists at ${targetDir}`);
    process.exit(0);
  }

  console.log(`Downloading ${model.hf} (${model.dims}d)...`);
  console.log('This may take a few minutes depending on your connection.\n');

  // Use @xenova/transformers to download to its cache, then copy
  const { pipeline, env } = await import('@xenova/transformers');

  const pipe = await pipeline('feature-extraction', model.hf, { quantized: true });

  // Verify it works
  const out = await pipe('test', { pooling: 'mean', normalize: true });
  console.log(`Model loaded: ${out.data.length} dimensions`);

  // Find cached files and copy to models directory
  const cacheBase = join(dirname(fileURLToPath(import.meta.resolve('@xenova/transformers'))), '.cache', model.hf.replace('/', '/'));

  // Check common cache locations
  const cachePaths = [
    cacheBase,
    join(process.env.HOME || '/root', '.cache', 'huggingface', 'hub', `models--${model.hf.replace('/', '--')}`, 'snapshots'),
  ];

  // Use env.cacheDir if available
  const transformersCacheDir = join(dirname(fileURLToPath(import.meta.resolve('@xenova/transformers'))), '.cache');
  const hfDir = join(transformersCacheDir, ...model.hf.split('/'));

  if (existsSync(hfDir)) {
    mkdirSync(join(targetDir, 'onnx'), { recursive: true });
    cpSync(hfDir, targetDir, { recursive: true });
    console.log(`\nModel saved to ${targetDir}`);
  } else {
    console.log(`\nModel downloaded to cache but could not auto-copy.`);
    console.log(`Cache location: ${transformersCacheDir}`);
    console.log(`Please manually copy the model files to: ${targetDir}`);
    console.log(`Required files: config.json, tokenizer.json, tokenizer_config.json, onnx/model_quantized.onnx`);
  }

  // Cleanup
  pipe.dispose?.();
}

main().catch(err => {
  console.error('Download failed:', err.message);
  process.exit(1);
});
