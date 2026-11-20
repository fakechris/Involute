# Chinese search tokenizer evaluation (INV-937)

**Recommendation: keep bigrams.** Jieba removed the cross-boundary full-text
match for `工单` in `人工单据`, but the required literal recall path still
returned it. The small ranking gain does not justify replacing the production
tokenizer or changing how the database keeps search vectors current.

## Reproduce

From the repository root, configure `DATABASE_URL` for a migrated local
PostgreSQL database with a name ending in `_test`, then run:

```sh
pnpm --filter @turnkeyai/involute-server prisma:generate
pnpm --filter @turnkeyai/involute-server prisma:migrate:deploy
pnpm --filter @turnkeyai/involute-server search:eval
```

The runner reads no issue rows and writes no data. It emits aggregate metrics
and the ranked document IDs for each query. The [corpus](../packages/server/prisma/search-eval-corpus.ts)
contains 42 synthetic Chinese and mixed-language work items and 20 hand-labeled
queries. It includes relevant and misleading substrings, queries with terms
spread across fields, mixed Chinese and English, an invented project name and
a query with no relevant documents. It contains no data from the hosted
instance or a private research folder.

The baseline uses the current PostgreSQL document-vector function and TypeScript
query compiler. The candidate uses `@node-rs/jieba` 2.0.4 with its bundled
dictionary, one domain entry (`工单 100`), and HMM disabled, on both sides.
Both are ranked by PostgreSQL `ts_rank_cd` with the same title (A) and
description (C) weights and document ID as the tie-breaker. The literal-recall
comparison includes any item containing all typed terms across those fields
even when it does not match the vector query.

This compares tokenization and its interaction with literal recall, not the
complete production ranking. It does not model substring scoring and title
bonuses, state, recency, identifier lookup, other searchable fields, or
embedding fusion. The fixture ranks are not production measurements.

## Results

Measured with PostgreSQL 14 and Node.js 22. Recall@10 is averaged across the
19 queries with at least one relevant item. False hits are non-relevant
returned items in the first five results, summed across all 20 queries.

| Tokenizer | Recall path | Mean recall@10 | False hits in top 5 |
| --- | --- | ---: | ---: |
| Bigrams | Full text only | 98.68% | 4 |
| Jieba | Full text only | 98.68% | 2 |
| Bigrams | Full text + literal | 98.68% | 4 |
| Jieba | Full text + literal | 98.68% | 3 |

For `工单`, both tokenizers recalled all four relevant items in the first
ten results. Bigrams also ranked the two invoice items first and third. Jieba
removed both from full-text results, but with literal recall enabled they
returned at ranks five and six. Jieba therefore does not satisfy the
requirement that `工单` no longer find `人工单据` without further changes to
search behavior. Leave the production query and document tokenizers unchanged.
