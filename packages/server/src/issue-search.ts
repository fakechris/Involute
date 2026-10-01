import type { Issue, Prisma, PrismaClient, WorkflowState } from '@prisma/client';

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
const STATE_WEIGHT: Record<string, number> = {
  STARTED: 5,
  UNSTARTED: 4,
  BACKLOG: 2,
};

export interface ParsedSearchQuery {
  /** Words and quoted phrases, each of which must be found somewhere. */
  terms: string[];
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
  const terms: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (const match of query.matchAll(pattern)) {
    const term = (match[1] ?? match[2] ?? '').trim();
    if (term && !terms.some((existing) => existing.toLowerCase() === term.toLowerCase())) {
      terms.push(term);
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
  const patterns = parsed.terms.map(escapeLikePattern);
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
  const clauses: Prisma.IssueWhereInput[] = [
    identifierMatch ? { OR: [identifierMatch, textMatch] } : textMatch,
  ];
  if (readableWhere) clauses.push(readableWhere);
  if (input.where) clauses.push(input.where);

  const include = {
    state: true,
    // Only comments that contain a word: they decide comment hits and snippets.
    comments: {
      where: { OR: patterns.map((term) => ({ body: { contains: term, mode: 'insensitive' as const } })) },
      orderBy: { createdAt: 'asc' as const },
      select: { id: true, body: true },
      take: 5,
    },
  } satisfies Prisma.IssueInclude;
  const recallLimit = input.recallLimit ?? RECALL_LIMIT;
  const recall = (where: Prisma.IssueWhereInput) =>
    prisma.issue.findMany({
      where,
      include,
      orderBy: [{ updatedAt: 'desc' }, { identifier: 'asc' }],
      take: recallLimit,
    });

  // Recall is newest-first and capped, so strong matches get their own pass:
  // an old item found by number or title must not be pushed out by newer
  // items that only mention the words in a description or comment.
  const strongMatch: Prisma.IssueWhereInput = {
    OR: [
      ...(identifierMatch ? [identifierMatch] : []),
      ...patterns.map((term) => ({ title: { contains: term, mode: 'insensitive' as const } })),
    ],
  };
  const [strong, broad] = await Promise.all([
    recall({ AND: [...clauses, strongMatch] }),
    recall({ AND: clauses }),
  ]);
  const candidates = [...new Map([...broad, ...strong].map((issue) => [issue.id, issue])).values()];

  const hits = candidates.map(({ comments, ...issue }) => scoreIssue(issue, comments, parsed));
  hits.sort((left, right) =>
    right.score - left.score
    || right.issue.updatedAt.getTime() - left.issue.updatedAt.getTime()
    || left.issue.identifier.localeCompare(right.issue.identifier));
  return hits.slice(0, first);
}

function scoreIssue(
  issue: Issue & { state: WorkflowState },
  comments: Array<{ id: string; body: string }>,
  parsed: ParsedSearchQuery,
): IssueSearchHit {
  const title = issue.title.toLowerCase();
  const contract = CONTRACT_FIELDS.map((field) => issue[field] ?? '').filter(Boolean);
  let score = 0;
  let matchedField: SearchField | null = null;
  let snippet: { text: string; commentId: string | null } | null = null;
  let matchedTitleChars = 0;

  if (identifierMatches(issue.identifier, parsed.identifier)) {
    score += IDENTIFIER_WEIGHT;
    matchedField = 'identifier';
  }

  for (const term of parsed.terms) {
    const needle = term.toLowerCase();
    let best: Exclude<SearchField, 'identifier'> | null = null;
    if (title.includes(needle)) {
      best = 'title';
      matchedTitleChars += needle.length;
    } else {
      const contractText = contract.find((text) => text.toLowerCase().includes(needle));
      const comment = comments.find((candidate) => candidate.body.toLowerCase().includes(needle));
      if (contractText) {
        best = 'contract';
        snippet ??= { text: excerpt(contractText, needle), commentId: null };
      } else if (issue.description?.toLowerCase().includes(needle)) {
        best = 'description';
        snippet ??= { text: excerpt(issue.description, needle), commentId: null };
      } else if (comment) {
        best = 'comment';
        snippet ??= { text: excerpt(comment.body, needle), commentId: comment.id };
      }
    }
    if (best) {
      score += FIELD_WEIGHT[best];
      if (!matchedField || FIELD_WEIGHT[best] > fieldWeight(matchedField)) {
        matchedField = best;
      }
    }
  }

  const phrase = parsed.terms.join(' ').toLowerCase();
  if (title.startsWith(parsed.terms[0]!.toLowerCase())) score += TITLE_PREFIX_BONUS;
  if (parsed.terms.length > 1 && title.includes(phrase)) score += TITLE_PHRASE_BONUS;
  // Of two titles with the same words, the shorter one is closer to the query.
  if (title.length > 0) score += TITLE_COVERAGE_BONUS * Math.min(1, matchedTitleChars / title.length);
  score += STATE_WEIGHT[issue.state.type] ?? 0;

  return {
    issue,
    score,
    matchedField: matchedField ?? 'identifier',
    snippet: snippet?.text ?? null,
    commentId: snippet?.commentId ?? null,
  };
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
