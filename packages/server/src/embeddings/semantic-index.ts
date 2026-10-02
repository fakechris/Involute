import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import type { Embedder } from './embedder.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/** Items embedded per model call: small batches keep memory flat on a small box. */
const EMBED_BATCH = 4;
/** Characters of an item that are embedded; the model reads ~512 tokens anyway. */
const MAX_TEXT = 2000;
/**
 * A query whose best match stands no further above its tenth than this has
 * no semantic signal (calibrated on production data, INV-927: nonsense
 * queries sit at 0.005–0.010, real ones mostly above).
 */
export const MIN_SIGNAL_GAP = 0.007;

export interface SemanticMatch {
  id: string;
  similarity: number;
}

/** The text of an item that is embedded: what it is, its contract, its description. */
export function embeddingText(item: {
  title: string;
  outcome: string | null;
  scope: string | null;
  acceptance: string | null;
  description: string | null;
}): string {
  return [item.title, item.outcome, item.scope, item.acceptance, item.description]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TEXT);
}

function hashText(model: string, text: string): string {
  return createHash('sha256').update(model).update('\0').update(text).digest('hex');
}

/**
 * Vectors of every item for one model, kept in memory (896 items × 384 floats
 * is about 1.4 MB) and in IssueEmbedding so a restart does not re-embed.
 */
export class SemanticIndex {
  private readonly vectors = new Map<string, Float32Array>();
  private loaded = false;

  constructor(private readonly prisma: DatabaseClient, readonly embedder: Embedder) {}

  get size(): number {
    return this.vectors.size;
  }

  async load(): Promise<void> {
    const rows = await this.prisma.issueEmbedding.findMany({
      where: { model: this.embedder.model },
      select: { issueId: true, vector: true },
    });
    this.vectors.clear();
    for (const row of rows) this.vectors.set(row.issueId, Float32Array.from(row.vector));
    this.loaded = true;
  }

  /**
   * Embeds up to `limit` items that have no vector yet or changed since theirs
   * was made; returns how many it looked at (0 = up to date).
   */
  async refresh(limit = 32): Promise<number> {
    if (!this.loaded) await this.load();
    const model = this.embedder.model;
    const pending = await this.prisma.$queryRaw<Array<{
      id: string;
      title: string;
      outcome: string | null;
      scope: string | null;
      acceptance: string | null;
      description: string | null;
      contentHash: string | null;
    }>>`
      SELECT issue.id::text AS id, issue.title, issue.outcome, issue.scope, issue.acceptance, issue.description,
             embedding."contentHash"
        FROM "Issue" issue
        LEFT JOIN "IssueEmbedding" embedding ON embedding."issueId" = issue.id AND embedding.model = ${model}
       WHERE embedding."issueId" IS NULL OR embedding."updatedAt" < issue."updatedAt"
       ORDER BY issue."updatedAt" DESC
       LIMIT ${limit}
    `;
    const changed: Array<{ id: string; text: string; hash: string }> = [];
    for (const item of pending) {
      const text = embeddingText(item);
      const hash = hashText(model, text);
      if (hash === item.contentHash && this.vectors.has(item.id)) {
        // Touched but not reworded (a state change): only mark it seen.
        await this.prisma.issueEmbedding.update({
          where: { issueId_model: { issueId: item.id, model } },
          data: { contentHash: hash },
        });
      } else {
        changed.push({ id: item.id, text, hash });
      }
    }
    for (let start = 0; start < changed.length; start += EMBED_BATCH) {
      const batch = changed.slice(start, start + EMBED_BATCH);
      const vectors = await this.embedder.embedDocuments(batch.map((item) => item.text));
      for (const [index, item] of batch.entries()) {
        const vector = vectors[index]!;
        await this.prisma.issueEmbedding.upsert({
          where: { issueId_model: { issueId: item.id, model } },
          create: { issueId: item.id, model, contentHash: item.hash, vector: Array.from(vector) },
          update: { contentHash: item.hash, vector: Array.from(vector) },
        });
        this.vectors.set(item.id, vector);
      }
    }
    return pending.length;
  }

  /** Best matches for a vector, most similar first. */
  nearest(vector: Float32Array, limit: number, exclude?: ReadonlySet<string>): SemanticMatch[] {
    const matches: SemanticMatch[] = [];
    for (const [id, candidate] of this.vectors) {
      if (exclude?.has(id)) continue;
      let similarity = 0;
      for (let index = 0; index < vector.length; index += 1) similarity += vector[index]! * candidate[index]!;
      matches.push({ id, similarity });
    }
    return matches.sort((left, right) => right.similarity - left.similarity).slice(0, limit);
  }

  /**
   * Items closest in meaning to a search query, or none when the query has no
   * semantic signal (its best match does not stand out from the rest).
   */
  async search(query: string, limit: number): Promise<SemanticMatch[]> {
    if (!this.loaded) await this.load();
    if (this.vectors.size === 0) return [];
    const matches = this.nearest(await this.embedder.embedQuery(query), Math.max(limit, 10));
    const tenth = matches[Math.min(9, matches.length - 1)]!;
    if (matches.length >= 10 && matches[0]!.similarity - tenth.similarity < MIN_SIGNAL_GAP) return [];
    return matches.slice(0, limit);
  }

  /** Items whose text is closest to this text (proposal duplicates, similar bugs). */
  async similarTo(text: string, limit: number, exclude?: ReadonlySet<string>): Promise<SemanticMatch[]> {
    if (!this.loaded) await this.load();
    if (this.vectors.size === 0) return [];
    const [vector] = await this.embedder.embedDocuments([text.slice(0, MAX_TEXT)]);
    return this.nearest(vector!, limit, exclude);
  }
}

/**
 * Keeps the index current: catches up at start, then looks for new or
 * changed items every `intervalMs` (an edit is searchable within a minute).
 * Errors are logged and retried on the next tick.
 */
export function startSemanticIndexer(index: SemanticIndex, intervalMs = 20_000): { stop: () => void } {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      // Keep going until nothing is pending; the bound guards against an item
      // whose updatedAt is ahead of this clock being picked up forever.
      for (let round = 0; round < 200 && !stopped; round += 1) {
        if ((await index.refresh()) === 0) break;
      }
    } catch (error) {
      console.error('[semantic-index] refresh failed; retrying on the next tick.', error);
    } finally {
      running = false;
    }
  };
  // Load the model now rather than on the first search.
  void index.embedder.embedQuery('warm up').catch((error: unknown) => {
    console.error('[semantic-index] model failed to load; search answers by keyword until it does.', error);
  });
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
