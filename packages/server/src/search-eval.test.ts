import { PrismaClient } from '@prisma/client';
import { expect, it } from 'vitest';

import { documents, queries } from '../prisma/search-eval-corpus.ts';
import { evaluateSearch, scoreRanking, summarize } from '../prisma/search-eval.ts';

it('labels distinct queries against a corpus of identifiable synthetic work', () => {
  const ids = new Set(documents.map(({ id }) => id));
  expect(ids.size).toBe(documents.length);
  expect(new Set(queries.map(({ query }) => query)).size).toBe(queries.length);
  for (const { relevant } of queries) {
    expect(new Set(relevant).size).toBe(relevant.length);
    expect(relevant.every((id) => ids.has(id))).toBe(true);
  }
});

it('scores recall at ten and counts only returned false hits in the first five', () => {
  expect(scoreRanking({ query: 'test', relevant: ['A', 'B'] },
    ['A', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'B'])).toEqual({
    recallAt10: 0.5,
    falseHitsAt5: 4,
  });
  expect(scoreRanking({ query: 'no relevant documents', relevant: [] }, ['a'])).toEqual({
    recallAt10: null,
    falseHitsAt5: 1,
  });
});

it('distinguishes a jieba word boundary from a bigram match and preserved literal recall', async () => {
  const prisma = new PrismaClient();
  try {
    const cases = await evaluateSearch(prisma);
    const workItems = cases.find(({ query }) => query === '工单')!;
    expect(workItems.bigrams.fullText).toContain('invoice');
    expect(workItems.jieba.fullText).not.toContain('invoice');
    expect(workItems.jieba.fullText).toContain('work-export');
    expect(workItems.jieba.withLiteralRecall).toContain('invoice');
    expect(summarize(cases)).toHaveLength(4);
  } finally {
    await prisma.$disconnect();
  }
});
