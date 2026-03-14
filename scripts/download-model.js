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

import { existsSync, mkdirSync, cpSync, readdirSync, statSync } from 'fs';
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

// Recursively find a file by name under a directory
function findFile(dir, name) {
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (entry === name) return full;
      if (statSync(full).isDirectory()) {
        const found = findFile(full, name);
        if (found) return found;
      }
    }
  } catch { /* ignore permission errors */ }
  return null;
}

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

  // Locate cached model files — try known paths, then search
  const transformersPkg = dirname(fileURLToPath(import.meta.resolve('@xenova/transformers')));
  const candidates = [
    join(transformersPkg, '.cache', ...model.hf.split('/')),
    join(transformersPkg, '.cache', model.hf.replace('/', '_')),
  ];

  let cacheDir = candidates.find(d => existsSync(join(d, 'config.json')));

  // Fallback: search the entire .cache directory
  if (!cacheDir) {
    console.log('Searching for cached model files...');
    const cacheBase = join(transformersPkg, '.cache');
    if (existsSync(cacheBase)) {
      const configPath = findFile(cacheBase, 'config.json');
      if (configPath) {
        // Walk up to find a directory that looks like the model root
        // (contains config.json + tokenizer.json)
        let candidate = dirname(configPath);
        if (existsSync(join(candidate, 'tokenizer.json'))) {
          cacheDir = candidate;
        }
      }
    }
  }

  if (cacheDir) {
    mkdirSync(targetDir, { recursive: true });
    cpSync(cacheDir, targetDir, { recursive: true });
    // Verify the copy
    const required = ['config.json', 'tokenizer.json'];
    const missing = required.filter(f => !existsSync(join(targetDir, f)));
    if (missing.length > 0) {
      console.error(`\nWarning: copied files but missing: ${missing.join(', ')}`);
      console.error(`Check: ls ${targetDir}`);
      process.exit(1);
    }
    console.log(`\nModel saved to ${targetDir}`);
    console.log(`Files: ${readdirSync(targetDir).join(', ')}`);
  } else {
    console.error(`\nError: Model downloaded but cached files could not be located.`);
    console.error(`\nManual fix:`);
    console.error(`  find node_modules/@xenova/transformers/.cache -name "config.json"`);
    console.error(`  # Copy the directory containing config.json to:`);
    console.error(`  cp -r <cache-dir>/* ${targetDir}/`);
    process.exit(1);
  }

  // Cleanup
  pipe.dispose?.();
}

main().catch(err => {
  console.error('Download failed:', err.message);
  process.exit(1);
});
