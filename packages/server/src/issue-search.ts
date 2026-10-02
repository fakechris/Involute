import type { Issue, Prisma, PrismaClient, WorkflowState } from '@prisma/client';

import { buildSearchTsQuery, segmentQueryWord } from './search-tokens.js';

/**
 * Free-text search over work items (INV-925): identifier, title, description,
 * contract fields and comments, ranked by where the words were found.
 *
 * Recall is plain `ILIKE` through Prisma (`contains`, insensitive), so Chinese
 * works without segmentation and a two-character word is never dropped (a
 * trigram index needs three; planofplan INV-899 lost short words that way).
 * The pg_trgm GIN indexes only make those scans cheaper. Ranking runs here on
 * the bounded recall set, which keeps the rules readable and testable.
 */

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const DEFAULT_SEARCH_FIRST = 20;
export const MAX_SEARCH_FIRST = 100;
/** Candidates ranked per query; recall is newest-first beyond this. */
const RECALL_LIMIT = 500;
/** Full-text matches considered before scoping; a bound, far above real use. */
const FULL_TEXT_MATCH_CAP = 5000;
const MAX_TERMS = 8;
const SNIPPET_RADIUS = 40;

export type SearchField = 'identifier' | 'title' | 'contract' | 'description' | 'comment';

const CONTRACT_FIELDS = ['outcome', 'scope', 'constraints', 'acceptance', 'verification'] as const;

// A word found in the title outweighs any number of words found only in
// comments, so a title hit always ranks above a comment-only hit.
const FIELD_WEIGHT: Record<Exclude<SearchField, 'identifier'>, number> = {
  title: 40,
  contract: 20,
  description: 12,
  comment: 6,
};
const IDENTIFIER_WEIGHT = 1000;
const TITLE_PREFIX_BONUS = 20;
const TITLE_PHRASE_BONUS = 15;
const TITLE_COVERAGE_BONUS = 10;
const FULL_TEXT_RANK_WEIGHT = 10;
const STATE_WEIGHT: Record<string, number> = {
  STARTED: 5,
  UNSTARTED: 4,
  BACKLOG: 2,
};

export interface SearchTerm {
  text: string;
  /** Typed in quotes: must appear exactly as typed. */
  quoted: boolean;
  /** The word cut into segments (INV-926): 候选审批 → 候选, 审批. */
  pieces: string[];
  /** What must be found, each somewhere: the quoted text, or the pieces. */
  needles: string[];
}

export interface ParsedSearchQuery {
  /** Words and quoted phrases, each of which must be found somewhere. */
  terms: SearchTerm[];
  /** `INV-925`, `inv925`, `inv 925` → `INV-925`; bare `925` → number only. */
  identifier: { prefix: string | null; number: string } | null;
}

export interface IssueSearchInput {
  query: string;
  first?: number | null;
  /** Extra filters (IQL, team, commitment) ANDed with the text match. */
  where?: Prisma.IssueWhereInput | null;
  /** Candidates per recall pass; tests lower it. */
  recallLimit?: number;
}

export interface IssueSearchHit {
  issue: Issue & { state: WorkflowState };
  score: number;
  /** The strongest field a word was found in. */
  matchedField: SearchField;
  /** Text around the first match outside the title, if any. */
  snippet: string | null;
  /** The comment the snippet came from, when it came from one. */
  commentId: string | null;
}

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const query = raw.trim();
  const terms: SearchTerm[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (const match of query.matchAll(pattern)) {
    const text = (match[1] ?? match[2] ?? '').trim();
    if (text && !terms.some((existing) => existing.text.toLowerCase() === text.toLowerCase())) {
      const quoted = match[1] !== undefined;
      const pieces = segmentQueryWord(text);
      terms.push({ text, quoted, pieces, needles: quoted ? [text.toLowerCase()] : pieces });
    }
  }

  const identifierMatch = /^([A-Za-z]{2,10})[\s-]?(\d+)$/.exec(query) ?? /^()(\d+)$/.exec(query);
  const identifier = identifierMatch
    ? { prefix: identifierMatch[1] ? identifierMatch[1].toUpperCase() : null, number: String(Number(identifierMatch[2])) }
    : null;

  return { terms: terms.slice(0, MAX_TERMS), identifier };
}

export async function searchIssues(
  prisma: DatabaseClient,
  input: IssueSearchInput,
  readableWhere?: Prisma.IssueWhereInput,
): Promise<IssueSearchHit[]> {
  const parsed = parseSearchQuery(input.query);
  if (parsed.terms.length === 0) {
    return [];
  }
  const first = clampSearchFirst(input.first);

  // Prisma passes `contains` through to ILIKE unescaped: `100%` would match `1000`.
  const patterns = parsed.terms.map((term) => escapeLikePattern(term.text));
  const textMatch: Prisma.IssueWhereInput = {
    AND: patterns.map((term) => ({
      OR: [
        { identifier: { contains: term, mode: 'insensitive' } },
        { title: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        ...CONTRACT_FIELDS.map((field) => ({ [field]: { contains: term, mode: 'insensitive' } })),
        { comments: { some: { body: { contains: term, mode: 'insensitive' } } } },
      ] as Prisma.IssueWhereInput[],
    })),
  };
  const identifierMatch = buildIdentifierWhere(parsed.identifier);
  const scope: Prisma.IssueWhereInput[] = [];
  if (readableWhere) scope.push(readableWhere);
  if (input.where) scope.push(input.where);

  const commentNeedles = [...new Set(parsed.terms.flatMap((term) => term.needles))].map(escapeLikePattern);
  const include = {
    state: true,
    // Only comments that contain a word: they decide comment hits and snippets.
    comments: {
      where: { OR: commentNeedles.map((needle) => ({ body: { contains: needle, mode: 'insensitive' as const } })) },
      orderBy: { createdAt: 'asc' as const },
      select: { id: true, body: true },
      take: 5,
    },
  } satisfies Prisma.IssueInclude;
  const recallLimit = input.recallLimit ?? RECALL_LIMIT;
  const recall = (where: Prisma.IssueWhereInput) =>
    prisma.issue.findMany({
      where: { AND: [where, ...scope] },
      include,
      orderBy: [{ updatedAt: 'desc' }, { identifier: 'asc' }],
      take: recallLimit,
    });

  // Three recall passes, merged and then checked word by word below:
  // - substring (ILIKE), newest first: every word appears as typed;
  // - by number or title, so an old strong match is not pushed out by newer
  //   items that only mention the words in a description or comment;
  // - ranked full text (INV-926), best first: words found apart, such as
  //   候选审批 in 「候选队列的审批」.
  const strongMatch: Prisma.IssueWhereInput = {
    OR: [
      ...(identifierMatch ? [identifierMatch] : []),
      ...patterns.map((term) => ({ title: { contains: term, mode: 'insensitive' as const } })),
    ],
  };
  const ranks = await rankByFullText(prisma, parsed);
  // Ranked best-first among what this viewer may read and the filters allow,
  // so matches elsewhere cannot use up the limit.
  const rankedIds = ranks.size > 0
    ? (await prisma.issue.findMany({ where: { AND: [{ id: { in: [...ranks.keys()] } }, ...scope] }, select: { id: true } }))
        .map(({ id }) => id)
        .sort((left, right) => (ranks.get(right) ?? 0) - (ranks.get(left) ?? 0))
        .slice(0, recallLimit)
    : [];
  const [broad, strong, ranked] = await Promise.all([
    recall(identifierMatch ? { OR: [identifierMatch, textMatch] } : textMatch),
    recall(strongMatch),
    rankedIds.length > 0 ? recall({ id: { in: rankedIds } }) : Promise.resolve([]),
  ]);
  const candidates = [...new Map([...broad, ...strong, ...ranked].map((issue) => [issue.id, issue])).values()];

  const hits = candidates
    .map(({ comments, ...issue }) => scoreIssue(issue, comments, parsed, ranks.get(issue.id) ?? 0))
    .filter((hit): hit is IssueSearchHit => hit !== null);
  hits.sort((left, right) =>
    right.score - left.score
    || right.issue.updatedAt.getTime() - left.issue.updatedAt.getTime()
    || left.issue.identifier.localeCompare(right.issue.identifier));
  return hits.slice(0, first);
}

/**
 * Ids of items (or their comments) matching the full-text query, with their
 * best rank. Unscoped: the caller narrows to what the viewer may read.
 */
async function rankByFullText(
  prisma: DatabaseClient,
  parsed: ParsedSearchQuery,
): Promise<Map<string, number>> {
  const tsQuery = buildSearchTsQuery(parsed.terms.flatMap((term) => term.pieces));
  if (!tsQuery) {
    return new Map();
  }
  const rows = await prisma.$queryRaw<Array<{ id: string; rank: number }>>`
    WITH query AS (SELECT ${tsQuery} AS q)
    SELECT id::text AS id, max(rank)::float8 AS rank FROM (
      SELECT issue.id, ts_rank_cd(issue."searchVector", query.q) AS rank
        FROM "Issue" issue, query WHERE issue."searchVector" @@ query.q
      UNION ALL
      SELECT comment."issueId", ts_rank_cd(comment."searchVector", query.q)
        FROM "Comment" comment, query WHERE comment."searchVector" @@ query.q
    ) matches
    GROUP BY id
    ORDER BY rank DESC
    LIMIT ${FULL_TEXT_MATCH_CAP}
  `;
  return new Map(rows.map((row) => [row.id, row.rank]));
}

type TextField = Exclude<SearchField, 'identifier'>;

/**
 * Null when some word is not found (and the item was not asked for by
 * number). A word is found when each of its needles is in some field; it
 * counts as strong as the weakest field one of them needed.
 */
function scoreIssue(
  issue: Issue & { state: WorkflowState },
  comments: Array<{ id: string; body: string }>,
  parsed: ParsedSearchQuery,
  fullTextRank: number,
): IssueSearchHit | null {
  const title = issue.title.toLowerCase();
  const contract = CONTRACT_FIELDS.map((field) => issue[field] ?? '').filter(Boolean);
  const byIdentifier = identifierMatches(issue.identifier, parsed.identifier);
  let score = byIdentifier ? IDENTIFIER_WEIGHT : 0;
  let matchedField: SearchField | null = byIdentifier ? 'identifier' : null;
  let snippet: { text: string; commentId: string | null } | null = null;
  let matchedTitleChars = 0;

  for (const term of parsed.terms) {
    let weakest: TextField | null = null;
    for (const needle of term.needles) {
      const found = findNeedle(needle, title, contract, issue.description, comments);
      if (!found) {
        weakest = null;
        break;
      }
      if (found.field === 'title') {
        matchedTitleChars += needle.length;
      } else {
        snippet ??= { text: excerpt(found.text, needle), commentId: found.commentId };
      }
      if (!weakest || FIELD_WEIGHT[found.field] < FIELD_WEIGHT[weakest]) {
        weakest = found.field;
      }
    }
    if (!weakest) {
      if (byIdentifier) continue;
      return null;
    }
    score += FIELD_WEIGHT[weakest];
    if (!matchedField || FIELD_WEIGHT[weakest] > fieldWeight(matchedField)) {
      matchedField = weakest;
    }
  }

  const phrase = parsed.terms.map((term) => term.text).join(' ').toLowerCase();
  if (title.startsWith(parsed.terms[0]!.needles[0]!)) score += TITLE_PREFIX_BONUS;
  if (parsed.terms.length > 1 && title.includes(phrase)) score += TITLE_PHRASE_BONUS;
  // Of two titles with the same words, the shorter one is closer to the query.
  if (title.length > 0) score += TITLE_COVERAGE_BONUS * Math.min(1, matchedTitleChars / title.length);
  // How often and how close together the words occur, weighted by field.
  score += FULL_TEXT_RANK_WEIGHT * Math.min(1, fullTextRank);
  score += STATE_WEIGHT[issue.state.type] ?? 0;

  return {
    issue,
    score,
    matchedField: matchedField ?? 'identifier',
    snippet: snippet?.text ?? null,
    commentId: snippet?.commentId ?? null,
  };
}

function findNeedle(
  needle: string,
  title: string,
  contract: string[],
  description: string | null,
  comments: Array<{ id: string; body: string }>,
): { field: TextField; text: string; commentId: string | null } | null {
  if (title.includes(needle)) return { field: 'title', text: title, commentId: null };
  const contractText = contract.find((text) => text.toLowerCase().includes(needle));
  if (contractText) return { field: 'contract', text: contractText, commentId: null };
  if (description?.toLowerCase().includes(needle)) return { field: 'description', text: description, commentId: null };
  const comment = comments.find((candidate) => candidate.body.toLowerCase().includes(needle));
  if (comment) return { field: 'comment', text: comment.body, commentId: comment.id };
  return null;
}

function fieldWeight(field: SearchField): number {
  return field === 'identifier' ? IDENTIFIER_WEIGHT : FIELD_WEIGHT[field];
}

function buildIdentifierWhere(identifier: ParsedSearchQuery['identifier']): Prisma.IssueWhereInput | null {
  if (!identifier) return null;
  return identifier.prefix
    ? { identifier: { equals: `${identifier.prefix}-${identifier.number}`, mode: 'insensitive' } }
    : { identifier: { endsWith: `-${identifier.number}` } };
}

function identifierMatches(value: string, identifier: ParsedSearchQuery['identifier']): boolean {
  if (!identifier) return false;
  const upper = value.toUpperCase();
  return identifier.prefix
    ? upper === `${identifier.prefix}-${identifier.number}`
    : upper.endsWith(`-${identifier.number}`);
}

function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function excerpt(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const index = flat.toLowerCase().indexOf(needle);
  if (index < 0) return flat.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(flat.length, index + needle.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

export function clampSearchFirst(first: number | null | undefined): number {
  if (first === undefined || first === null || !Number.isFinite(first) || first < 1) {
    return DEFAULT_SEARCH_FIRST;
  }
  return Math.min(Math.floor(first), MAX_SEARCH_FIRST);
}
