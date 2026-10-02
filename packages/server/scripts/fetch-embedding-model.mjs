// Downloads the semantic search model into a directory at image build time
// (INV-927), so the server loads it from disk and never fetches at runtime.
// Usage: node scripts/fetch-embedding-model.mjs <dir> [model]
import { env, pipeline } from '@huggingface/transformers';

const [dir, model = 'Xenova/multilingual-e5-small'] = process.argv.slice(2);
if (!dir) {
  console.error('Usage: node scripts/fetch-embedding-model.mjs <dir> [model]');
  process.exit(1);
}
env.cacheDir = dir;
env.allowRemoteModels = true;
// A dropped connection should not fail an image build: try a few times.
let embed;
for (let attempt = 1; ; attempt += 1) {
  try {
    embed = await pipeline('feature-extraction', model, { dtype: 'q8' });
    break;
  } catch (error) {
    if (attempt >= 3) throw error;
    console.error(`Fetching ${model} failed (attempt ${attempt}): ${error.message}; retrying.`);
    await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
  }
}
const output = await embed(['passage: 预热'], { pooling: 'mean', normalize: true });
console.log(`Fetched ${model} into ${dir} (${output.dims.at(-1)} dimensions).`);
