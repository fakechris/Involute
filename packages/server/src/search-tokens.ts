import { Prisma } from '@prisma/client';

/**
 * Query side of ranked search (INV-926). The document side is the SQL
 * function involute_search_tokens() (migration 20261002020000_search_vector);
 * the two must agree:
 *
 * - Documents: text other than CJK goes to Postgres' `simple` parser, with
 *   hyphens read as spaces (as the segmenter splits INV-859 into inv, 859);
 *   each CJK run becomes its characters and adjacent pairs, in order, so the
 *   pairs of one run sit two positions apart.
 * - Queries: a query word is cut into segments by a QuerySegmenter. A CJK
 *   segment compiles to its pairs chained with `<2>` (a single character
 *   matches itself); anything else goes through plainto_tsquery('simple').
 *
 * Pairs make every word findable without a dictionary, including words a
 * dictionary lacks (工单). To use a dictionary segmenter later, swap the
 * QuerySegmenter and involute_search_tokens() together and run
 * `pnpm search:reindex`; callers do not change.
 */

export interface QuerySegmenter {
  /** Word-like pieces of `text`, in order; punctuation and spaces dropped. */
  segment(text: string): string[];
}

const WORD_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });

export const intlQuerySegmenter: QuerySegmenter = {
  segment(text) {
    return [...WORD_SEGMENTER.segment(text)]
      .filter((piece) => piece.isWordLike)
      .map((piece) => piece.segment);
  },
};

// Kana and CJK ideographs: the ranges involute_search_tokens() spells out.
const CJK_RUN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+/gu;
const HAS_WORD_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * The pieces of one query word that must all be present: CJK runs and the
 * text between them. Scoring checks these as substrings; the tsquery checks
 * them against the index.
 */
export function segmentQueryWord(word: string, segmenter: QuerySegmenter = intlQuerySegmenter): string[] {
  const pieces: string[] = [];
  // A word the dictionary lacks comes back one character at a time (工单 →
  // 工 | 单). The user typed those characters together, so they stay together;
  // otherwise 工 and 单 anywhere in a document would match.
  let singles = '';
  const flushSingles = () => {
    if (singles) pieces.push(singles);
    singles = '';
  };
  for (const segment of segmenter.segment(word.toLowerCase())) {
    if (isCjkRun(segment) && [...segment].length === 1) {
      singles += segment;
      continue;
    }
    flushSingles();
    let last = 0;
    for (const match of segment.matchAll(CJK_RUN)) {
      pushPlain(pieces, segment.slice(last, match.index));
      pieces.push(match[0]);
      last = match.index + match[0].length;
    }
    pushPlain(pieces, segment.slice(last));
  }
  flushSingles();
  return pieces.length > 0 ? pieces : [word.toLowerCase()];
}

function pushPlain(pieces: string[], text: string) {
  const trimmed = text.trim();
  if (HAS_WORD_CHARACTER.test(trimmed)) {
    pieces.push(trimmed);
  }
}

/** A CJK run as a tsquery: 候选队列 → '候选' <2> '选队' <2> '队列'. */
export function compileCjkRun(run: string): string {
  const characters = [...run];
  if (characters.length === 1) {
    return `'${characters[0]}'`;
  }
  const pairs: string[] = [];
  for (let index = 0; index < characters.length - 1; index += 1) {
    pairs.push(`'${characters[index]}${characters[index + 1]}'`);
  }
  return pairs.join(' <2> ');
}

function isCjkRun(piece: string): boolean {
  CJK_RUN.lastIndex = 0;
  const match = CJK_RUN.exec(piece);
  CJK_RUN.lastIndex = 0;
  return match !== null && match[0] === piece;
}

/**
 * The tsquery requiring every piece (from segmentQueryWord), or null when
 * none of them can be searched for.
 */
export function buildSearchTsQuery(pieces: string[]): Prisma.Sql | null {
  const parts = pieces.map((piece) => (isCjkRun(piece)
    ? Prisma.sql`to_tsquery('simple', ${compileCjkRun(piece)})`
    : Prisma.sql`plainto_tsquery('simple', ${piece})`));
  return parts.length > 0 ? Prisma.join(parts, ' && ') : null;
}
