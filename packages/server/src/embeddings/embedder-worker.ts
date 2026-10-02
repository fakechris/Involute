import { parentPort, workerData } from 'node:worker_threads';

/**
 * Runs the embedding model off the main thread (INV-927): tokenizing and
 * inference take hundreds of milliseconds per batch, which would otherwise
 * stall every request while the index catches up.
 */
interface WorkerOptions {
  model: string;
  cacheDir: string | null;
  allowDownload: boolean;
}

interface EmbedRequest {
  id: number;
  texts: string[];
}

type Extract = (texts: string[], settings: object) => Promise<{ tolist(): number[][] }>;

const options = workerData as WorkerOptions;
let extractor: Promise<Extract> | null = null;

function load(): Promise<Extract> {
  extractor ??= (async () => {
    const transformers = await import('@huggingface/transformers');
    if (options.cacheDir) transformers.env.cacheDir = options.cacheDir;
    transformers.env.allowRemoteModels = options.allowDownload;
    const pipe = await transformers.pipeline('feature-extraction', options.model, { dtype: 'q8' });
    return (texts, settings) => pipe(texts, settings) as Promise<{ tolist(): number[][] }>;
  })();
  // A failed load is not kept: the next request tries again.
  extractor.catch(() => {
    extractor = null;
  });
  return extractor;
}

parentPort!.on('message', async ({ id, texts }: EmbedRequest) => {
  try {
    const extract = await load();
    const output = await extract(texts, { pooling: 'mean', normalize: true });
    const vectors = output.tolist().map((values) => Float32Array.from(values));
    parentPort!.postMessage({ id, vectors }, vectors.map((vector) => vector.buffer));
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
