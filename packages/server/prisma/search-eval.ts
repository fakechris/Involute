import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict.js';
import { Prisma, type PrismaClient } from '@prisma/client';

import { parseSearchQuery } from '../src/issue-search.ts';
import { buildSearchTsQuery } from '../src/search-tokens.ts';
import { documents, queries, type EvalQuery } from './search-eval-corpus.ts';

const jieba = Jieba.withDict(dict);
jieba.loadDict(Buffer.from('工单 100\n'));

function segment(text: string): string {
  return text.replace(/-/g, ' ').replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+/gu,
    (run) => ` ${jieba.cut(run, false).join(' ')} `);
}

export function scoreRanking(query: EvalQuery, rankedIds: readonly string[]) {
  const relevant = new Set(query.relevant);
  return {
    recallAt10: relevant.size
      ? rankedIds.slice(0, 10).filter((id) => relevant.has(id)).length / relevant.size
      : null,
    falseHitsAt5: rankedIds.slice(0, 5).filter((id) => !relevant.has(id)).length,
  };
}

async function rank(prisma: PrismaClient, query: EvalQuery, mode: 'bigrams' | 'jieba') {
  const terms = parseSearchQuery(query.query).terms;
  const tsQuery = mode === 'bigrams'
    ? buildSearchTsQuery(terms.flatMap((term) => term.pieces))
    : Prisma.sql`plainto_tsquery('simple', ${segment(terms.map((term) => term.text).join(' '))})`;
  const vector = mode === 'bigrams'
    ? Prisma.sql`involute_issue_search_vector(title, NULL, NULL, NULL, NULL, NULL, description)`
    : Prisma.sql`setweight(to_tsvector('simple', tokenized_title), 'A')
        || setweight(to_tsvector('simple', tokenized_description), 'C')`;
  const literalMatch = Prisma.join(terms.map(({ text }) => Prisma.sql`
    (strpos(lower(title), ${text.toLowerCase()}) > 0 OR strpos(lower(description), ${text.toLowerCase()}) > 0)
  `), ' AND ');
  const rows = await prisma.$queryRaw<{ id: string; fullText: boolean }[]>`
    WITH corpus AS (
      SELECT * FROM unnest(
        ${documents.map((doc) => doc.id)}::text[],
        ${documents.map((doc) => doc.title)}::text[],
        ${documents.map((doc) => doc.description ?? '')}::text[],
        ${documents.map((doc) => mode === 'jieba' ? segment(doc.title) : '')}::text[],
        ${documents.map((doc) => mode === 'jieba' ? segment(doc.description ?? '') : '')}::text[]
      ) AS doc(id, title, description, tokenized_title, tokenized_description)
    ), vectors AS (
      SELECT id, ${vector} AS vector, (${literalMatch}) AS literal FROM corpus
    ), query AS (
      SELECT ${tsQuery} AS q
    )
    SELECT id, vector @@ q AS "fullText"
    FROM vectors CROSS JOIN query
    WHERE vector @@ q OR literal
    ORDER BY ts_rank_cd(vector, q) DESC, id COLLATE "C"
  `;
  return {
    fullText: rows.filter((row) => row.fullText).map((row) => row.id),
    withLiteralRecall: rows.map((row) => row.id),
  };
}

export async function evaluateSearch(prisma: PrismaClient) {
  const cases = [];
  for (const query of queries) {
    const bigrams = await rank(prisma, query, 'bigrams');
    const jieba = await rank(prisma, query, 'jieba');
    cases.push({ ...query, bigrams, jieba });
  }
  return cases;
}

export function summarize(cases: Awaited<ReturnType<typeof evaluateSearch>>) {
  return (['bigrams', 'jieba'] as const).flatMap((tokenizer) =>
    (['fullText', 'withLiteralRecall'] as const).map((recall) => {
      const scores = cases.map((entry) => scoreRanking(entry, entry[tokenizer][recall]));
      const withRelevant = scores.flatMap((score) => score.recallAt10 ?? []);
      return {
        tokenizer,
        recall,
        meanRecallAt10: withRelevant.length ? withRelevant.reduce((sum, score) => sum + score, 0) / withRelevant.length : null,
        totalFalseHitsAt5: scores.reduce((sum, score) => sum + score.falseHitsAt5, 0),
      };
    }));
}
