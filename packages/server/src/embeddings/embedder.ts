import { Worker } from 'node:worker_threads';

/**
 * Text to vector, for semantic search (INV-927). The default runs a small
 * multilingual model in-process (transformers.js on onnxruntime-node): no
 * external API, no vector database. Tests use a deterministic fake.
 */
export interface Embedder {
  /** Names the vectors this embedder makes; stored with each vector. */
  readonly model: string;
  embedQuery(text: string): Promise<Float32Array>;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  /** Releases the model (stops its worker); called when the server stops. */
  dispose?(): Promise<void>;
}

export interface LocalEmbedderOptions {
  model: string;
  /** Where model files live; the image ships them so production never downloads. */
  cacheDir?: string | null;
  allowDownload?: boolean;
}

// e5 models are trained with these prefixes; others take the text as is.
function prefixesFor(model: string): { query: string; passage: string } {
  return /e5/i.test(model) ? { query: 'query: ', passage: 'passage: ' } : { query: '', passage: '' };
}

/**
 * Runs the model in a worker thread, started on first use, so a server that
 * never searches never loads it and indexing never stalls requests. If the
 * worker dies, pending calls fail and the next call starts a new one.
 */
export function createLocalEmbedder(options: LocalEmbedderOptions): Embedder {
  const prefixes = prefixesFor(options.model);
  let worker: Worker | null = null;
  let nextId = 0;
  const pending = new Map<number, {
    resolve: (vectors: Float32Array[]) => void;
    reject: (error: Error) => void;
    settled: Promise<unknown>;
  }>();

  // Only the current worker's death fails the pending calls; a worker already
  // replaced (after dispose) must not reject its successor's.
  const failAll = (from: Worker, error: Error) => {
    if (worker !== from) return;
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    worker = null;
  };

  const start = (): Worker => {
    // Built output runs the .js worker; running from source (tsx) needs the loader.
    const fromSource = import.meta.url.endsWith('.ts');
    const started = new Worker(new URL(`./embedder-worker.${fromSource ? 'ts' : 'js'}`, import.meta.url), {
      workerData: { model: options.model, cacheDir: options.cacheDir ?? null, allowDownload: options.allowDownload ?? false },
      ...(fromSource ? { execArgv: ['--import', 'tsx'] } : {}),
    });
    started.unref();
    started.on('message', (message: { id: number; vectors?: Float32Array[]; error?: string }) => {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (message.error !== undefined) call.reject(new Error(`Embedding failed: ${message.error}`));
      else call.resolve(message.vectors!);
    });
    started.on('error', (error) => failAll(started, error));
    started.on('exit', (code) => failAll(started, new Error(`Embedding worker exited (code ${code}).`)));
    return started;
  };

  const run = (texts: string[]): Promise<Float32Array[]> => {
    worker ??= start();
    const id = nextId++;
    const active = worker;
    let call!: { resolve: (vectors: Float32Array[]) => void; reject: (error: Error) => void };
    const result = new Promise<Float32Array[]>((resolve, reject) => {
      call = { resolve, reject };
    });
    pending.set(id, { ...call, settled: result.catch(() => undefined) });
    active.postMessage({ id, texts });
    return result;
  };

  return {
    model: options.model,
    async embedQuery(text) {
      const [vector] = await run([prefixes.query + text]);
      return vector!;
    },
    embedDocuments(texts) {
      return run(texts.map((text) => prefixes.passage + text));
    },
    async dispose() {
      const active = worker;
      if (!active) return;
      worker = null;
      // Terminating mid-inference aborts the whole process (onnxruntime), so
      // calls in flight finish first; a stuck one gets up to 5 s.
      const inFlight = [...pending.values()].map((call) => call.settled);
      await Promise.race([Promise.allSettled(inFlight), new Promise((resolve) => setTimeout(resolve, 5000))]);
      for (const call of pending.values()) call.reject(new Error('Embedding worker stopped.'));
      pending.clear();
      await active.terminate();
    },
  };
}

export interface EmbeddingSettings {
  enabled: boolean;
  model: string;
  cacheDir: string | null;
  allowDownload: boolean;
}

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';

/**
 * INVOLUTE_EMBEDDINGS=local turns semantic search on (the image sets it);
 * anything else, or unset, leaves keyword search only.
 */
export function readEmbeddingSettings(env: NodeJS.ProcessEnv = process.env): EmbeddingSettings {
  return {
    enabled: env.INVOLUTE_EMBEDDINGS?.trim() === 'local',
    model: env.INVOLUTE_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL,
    cacheDir: env.INVOLUTE_MODEL_DIR?.trim() || null,
    allowDownload: env.INVOLUTE_EMBEDDING_DOWNLOAD === 'true',
  };
}
