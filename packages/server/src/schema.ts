import type {
  Comment,
  Issue,
  IssueLabel,
  Prisma,
  PrismaClient,
  Team,
  User,
  WorkflowState,
} from '@prisma/client';

import { makeExecutableSchema } from '@graphql-tools/schema';
import {
  GraphQLScalarType,
  Kind,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLResolveInfo,
  type SelectionSetNode,
} from 'graphql';

import { getExposedError, isPrismaInvalidInputError } from './errors.js';
import type {
  CreateCommentInput,
  CreateIssueInput,
  UpdateIssueInput,
} from './issue-service.js';
import { buildIssueWhere, type IssueFilterInput } from './issue-filter.js';

import { requireAuthentication, type GraphQLContext } from './auth.js';
import { createComment, createIssue, deleteComment, deleteIssue, updateIssue } from './issue-service.js';
import { orderWorkflowStates } from './workflow-state-order.js';

type TeamParent = Team & { states?: WorkflowState[] | null };
type UserParent = User;
type CommentParent = Comment & { user?: User | null };
type IssueParent = Issue & {
  assignee?: User | null;
  comments?: CommentParent[] | null;
  children?: Issue[] | null;
  labels?: IssueLabel[] | null;
  parent?: Issue | null;
  state?: WorkflowState | null;
  team?: TeamParent | null;
};

interface StringComparatorInput {
  eq?: string | null;
  in?: string[] | null;
  nin?: string[] | null;
}

interface TeamFilterInput {
  key?: StringComparatorInput | null;
}

interface IssueLabelFilterInput {
  name?: StringComparatorInput | null;
}

type CommentOrderByInput = 'createdAt';
interface CursorPayload {
  createdAt: string;
  id: string;
}

const COMMENT_ORDER_BY: Prisma.CommentOrderByWithRelationInput[] = [
  { createdAt: 'asc' },
  { id: 'asc' },
];
const MAX_COMMENTS_CONNECTION_FIRST = 100;
const MAX_ISSUES_CONNECTION_FIRST = 200;

function buildIssueListInclude(
  options: { includeChildren?: boolean; includeComments?: boolean } = {},
): Prisma.IssueInclude {
  const include: Prisma.IssueInclude = {
    assignee: true,
    labels: {
      orderBy: {
        name: 'asc',
      },
    },
    parent: true,
    state: true,
    team: {
      include: {
        states: true,
      },
    },
  };

  if (options.includeChildren) {
    include.children = {
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    };
  }

  if (options.includeComments) {
    include.comments = {
      include: {
        user: true,
      },
      orderBy: COMMENT_ORDER_BY.slice(),
    };
  }

  return include;
}

function buildIssueDetailInclude(): Prisma.IssueInclude {
  return buildIssueListInclude({
    includeChildren: true,
    includeComments: true,
  });
}

const DateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  serialize(value: unknown): string {
    return serializeDateTime(value);
  },
  parseValue(value: unknown): Date {
    if (typeof value !== 'string') {
      throw new TypeError('DateTime values must be provided as ISO 8601 strings.');
    }

    return parseDateTime(value);
  },
  parseLiteral(ast): Date {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError('DateTime values must be provided as ISO 8601 strings.');
    }

    return parseDateTime(ast.value);
  },
});

const typeDefs = /* GraphQL */ `
  scalar DateTime

  type Query {
    issue(id: String!): Issue
    issues(first: Int!, after: String, filter: IssueFilter): IssueConnection!
    teams(filter: TeamFilter): TeamConnection!
    issueLabels(filter: IssueLabelFilter): IssueLabelConnection!
    users: UserConnection!
  }

  type Mutation {
    issueCreate(input: IssueCreateInput!): IssueCreatePayload!
    issueUpdate(id: String!, input: IssueUpdateInput!): IssueUpdatePayload!
    issueDelete(id: String!): IssueDeletePayload!
    commentCreate(input: CommentCreateInput!): CommentCreatePayload!
    commentDelete(id: String!): CommentDeletePayload!
  }

  type Team {
    id: ID!
    key: String!
    name: String!
    states: WorkflowStateConnection!
  }

  type WorkflowState {
    id: ID!
    name: String!
  }

  type IssueLabel {
    id: ID!
    name: String!
  }

  type User {
    id: ID!
    name: String
    email: String
    isMe: Boolean
  }

  type Comment {
    id: ID!
    body: String!
    createdAt: DateTime!
    user: User
  }

  enum CommentOrderBy {
    createdAt
  }

  type Issue {
    id: ID!
    identifier: String!
    title: String!
    description: String
    createdAt: DateTime!
    updatedAt: DateTime!
    state: WorkflowState!
    labels: IssueLabelConnection!
    assignee: User
    parent: Issue
    children: IssueConnection!
    team: Team!
    comments(first: Int, after: String, orderBy: CommentOrderBy): CommentConnection!
  }

  type TeamConnection {
    nodes: [Team!]!
  }

  type WorkflowStateConnection {
    nodes: [WorkflowState!]!
  }

  type IssueLabelConnection {
    nodes: [IssueLabel!]!
  }

  type IssueConnection {
    nodes: [Issue!]!
    pageInfo: PageInfo!
  }

  type UserConnection {
    nodes: [User!]!
  }

  type CommentConnection {
    nodes: [Comment!]!
    pageInfo: PageInfo!
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  input StringComparator {
    eq: String
    in: [String!]
    nin: [String!]
  }

  input BooleanComparator {
    eq: Boolean
  }

  input TeamFilter {
    key: StringComparator
  }

  input WorkflowStateFilterRef {
    name: StringComparator
  }

  input UserFilterRef {
    isMe: BooleanComparator
  }

  input IssueLabelFilterRef {
    name: StringComparator
  }

  input IssueLabelRelationFilter {
    some: IssueLabelFilterRef
    every: IssueLabelFilterRef
  }

  input IssueFilter {
    and: [IssueFilter!]
    team: TeamFilter
    state: WorkflowStateFilterRef
    assignee: UserFilterRef
    labels: IssueLabelRelationFilter
  }

  input IssueLabelFilter {
    name: StringComparator
  }

  input IssueCreateInput {
    teamId: String!
    title: String!
    description: String
    stateId: String
  }

  input IssueUpdateInput {
    stateId: String
    labelIds: [String!]
    parentId: String
    title: String
    description: String
    assigneeId: String
  }

  input CommentCreateInput {
    issueId: String!
    body: String!
  }

  type IssueCreatePayload {
    success: Boolean!
    issue: Issue
  }

  type IssueUpdatePayload {
    success: Boolean!
    issue: Issue
  }

  type IssueDeletePayload {
    success: Boolean!
    issueId: ID
  }

  type CommentCreatePayload {
    success: Boolean!
    comment: Comment
  }

  type CommentDeletePayload {
    success: Boolean!
    commentId: ID
  }
`;

const resolvers = {
  DateTime: DateTimeScalar,
  Query: {
    issue: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<IssueParent | null> => {
      try {
        const issue = await context.prisma.issue.findUnique({
          where: {
            id: args.id,
          },
          include: buildIssueDetailInclude(),
        });

        if (issue) {
          return issue;
        }
      } catch (error) {
        if (!isPrismaInvalidInputError(error)) {
          throw error;
        }
      }

      return context.prisma.issue.findUnique({
        where: {
          identifier: args.id,
        },
        include: buildIssueDetailInclude(),
      });
    },
    issues: async (
      _parent: unknown,
      args: { after?: string | null; filter?: IssueFilterInput | null; first: number },
      context: GraphQLContext,
      info: GraphQLResolveInfo,
    ): Promise<{ nodes: IssueParent[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }> => {
      const first = clampConnectionFirst(args.first, MAX_ISSUES_CONNECTION_FIRST);
      const where = combineIssueWhere(
        buildIssueWhere(args.filter, context.viewer?.id ?? null),
        buildIssueCursorWhere(args.after),
      );
      const requestedIssueFields = getRequestedIssueConnectionFields(info);
      const issues = await context.prisma.issue.findMany({
        ...(where ? { where } : {}),
        include: buildIssueListInclude({
          includeChildren: requestedIssueFields.has('children'),
          includeComments: requestedIssueFields.has('comments'),
        }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: first + 1,
      });
      const nodes = issues.slice(0, first);

      return {
        nodes,
        pageInfo: buildPageInfo(nodes, issues.length > first),
      };
    },
    teams: async (
      _parent: unknown,
      args: { filter?: TeamFilterInput | null },
      context: GraphQLContext,
    ): Promise<{ nodes: Team[] }> => {
      const where = buildTeamWhere(args.filter);

      return {
        nodes: await context.prisma.team.findMany({
          ...(where ? { where } : {}),
          orderBy: {
            key: 'asc',
          },
        }),
      };
    },
    issueLabels: async (
      _parent: unknown,
      args: { filter?: IssueLabelFilterInput | null },
      context: GraphQLContext,
    ): Promise<{ nodes: IssueLabel[] }> => {
      const where = buildIssueLabelWhere(args.filter);

      return {
        nodes: await context.prisma.issueLabel.findMany({
          ...(where ? { where } : {}),
          orderBy: {
            name: 'asc',
          },
        }),
      };
    },
    users: async (
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: User[] }> => ({
      nodes: await context.prisma.user.findMany({
        orderBy: [{ email: 'asc' }, { id: 'asc' }],
      }),
    }),
  },
  Mutation: {
    issueCreate: async (
      _parent: unknown,
      args: { input: CreateIssueInput },
      context: GraphQLContext,
    ): Promise<{ issue: IssueParent | null; success: boolean }> =>
      runMutation(async () => {
        const issue = await createIssue(context.prisma, args.input);

        return {
          issue: await getIssueById(context.prisma, issue.id),
          success: true as const,
        };
      }, {
        issue: null,
        success: false as const,
      }),
    issueUpdate: async (
      _parent: unknown,
      args: { id: string; input: UpdateIssueInput },
      context: GraphQLContext,
    ): Promise<{ issue: IssueParent | null; success: boolean }> =>
      runMutation(async () => {
        const issue = await updateIssue(context.prisma, args.id, args.input);

        return {
          issue: await getIssueById(context.prisma, issue.id),
          success: true as const,
        };
      }, {
        issue: null,
        success: false as const,
      }),
    issueDelete: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<{ issueId: string | null; success: boolean }> =>
      runMutation(async () => {
        const issue = await deleteIssue(context.prisma, args.id);

        return {
          issueId: issue.id,
          success: true as const,
        };
      }, {
        issueId: null,
        success: false as const,
      }),
    commentCreate: async (
      _parent: unknown,
      args: { input: CreateCommentInput },
      context: GraphQLContext,
    ): Promise<{ comment: CommentParent | null; success: boolean }> => {
      const viewer = requireAuthentication(context);

      return runMutation(async () => {
        const createdComment = await createComment(context.prisma, args.input, viewer.id);

        return {
          comment: {
            ...createdComment,
            user: viewer,
          },
          success: true as const,
        };
      }, {
        comment: null,
        success: false as const,
      });
    },
    commentDelete: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<{ commentId: string | null; success: boolean }> =>
      runMutation(async () => {
        const comment = await deleteComment(context.prisma, args.id);

        return {
          commentId: comment.id,
          success: true as const,
        };
      }, {
        commentId: null,
        success: false as const,
      }),
  },
  Team: {
    states: async (
      parent: TeamParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: WorkflowState[] }> => {
      const states =
        parent.states ??
        (await context.prisma.workflowState.findMany({
          where: {
            teamId: parent.id,
          },
        }));

      return {
        nodes: orderWorkflowStates(states),
      };
    },
  },
  User: {
    isMe: (parent: UserParent, _args: Record<string, never>, context: GraphQLContext): boolean =>
      context.viewer?.id === parent.id,
  },
  Comment: {
    user: async (
      parent: CommentParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User | null> =>
      parent.user ??
      context.prisma.user.findUnique({
        where: {
          id: parent.userId,
        },
      }),
  },
  Issue: {
    state: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<WorkflowState> =>
      parent.state ??
      context.prisma.workflowState.findUniqueOrThrow({
        where: {
          id: parent.stateId,
        },
      }),
    labels: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: IssueLabel[] }> => ({
      nodes:
        parent.labels ??
        (await context.prisma.issueLabel.findMany({
          where: {
            issues: {
              some: {
                id: parent.id,
              },
            },
          },
          orderBy: {
            name: 'asc',
          },
        })),
    }),
    assignee: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User | null> => {
      if (!parent.assigneeId) {
        return null;
      }

      return (
        parent.assignee ??
        context.prisma.user.findUnique({
          where: {
            id: parent.assigneeId,
          },
        })
      );
    },
    parent: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Issue | null> => {
      if (!parent.parentId) {
        return null;
      }

      return (
        parent.parent ??
        context.prisma.issue.findUnique({
          where: {
            id: parent.parentId,
          },
        })
      );
    },
    children: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: Issue[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }> => {
      const nodes =
        parent.children ??
        (await context.prisma.issue.findMany({
          where: {
            parentId: parent.id,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }));

      return {
        nodes,
        pageInfo: buildPageInfo(nodes, false),
      };
    },
    team: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Team> =>
      parent.team ??
      context.prisma.team.findUniqueOrThrow({
        where: {
          id: parent.teamId,
        },
      }),
    comments: async (
      parent: IssueParent,
      args: { after?: string | null; first?: number; orderBy?: CommentOrderByInput },
      context: GraphQLContext,
    ): Promise<{ nodes: Comment[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }> => {
      const first = args.first === undefined
        ? undefined
        : clampConnectionFirst(args.first, MAX_COMMENTS_CONNECTION_FIRST);

      if (
        parent.comments &&
        (args.after === undefined || args.after === null) &&
        isDefaultCommentOrder(args.orderBy)
      ) {
        const nodes = first === undefined ? parent.comments : parent.comments.slice(0, first);

        return {
          nodes,
          pageInfo: buildPageInfo(nodes, first !== undefined && parent.comments.length > first),
        };
      }

      const comments = await context.prisma.comment.findMany({
        where: buildCommentWhere(parent.id, args.after),
        orderBy: buildCommentOrderBy(args.orderBy),
        ...(first === undefined ? {} : { take: first + 1 }),
      });
      const nodes = first === undefined ? comments : comments.slice(0, first);

      return {
        nodes,
        pageInfo: buildPageInfo(nodes, first !== undefined && comments.length > first),
      };
    },
  },
};

export function createGraphQLSchema(_prisma: PrismaClient) {
  return makeExecutableSchema({
    typeDefs,
    resolvers,
  });
}

async function getIssueById(prisma: PrismaClient, id: string): Promise<IssueParent> {
  return prisma.issue.findUniqueOrThrow({
    where: {
      id,
    },
    include: buildIssueDetailInclude(),
  });
}

function buildTeamWhere(filter: TeamFilterInput | null | undefined) {
  const key = filter?.key?.eq;

  if (key === undefined || key === null) {
    return undefined;
  }

  return {
    key,
  };
}

function buildIssueLabelWhere(filter: IssueLabelFilterInput | null | undefined) {
  const name = filter?.name?.eq;

  if (name === undefined || name === null) {
    return undefined;
  }

  return {
    name,
  };
}

function serializeDateTime(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string') {
    return parseDateTime(value).toISOString();
  }

  throw new TypeError('DateTime values must be Date instances or ISO 8601 strings.');
}

function clampConnectionFirst(requestedFirst: number, maxFirst: number): number {
  if (!Number.isFinite(requestedFirst) || requestedFirst < 1) {
    return 1;
  }

  return Math.min(Math.trunc(requestedFirst), maxFirst);
}

function parseDateTime(value: string): Date {
  const parsedValue = new Date(value);

  if (Number.isNaN(parsedValue.getTime())) {
    throw new TypeError('DateTime values must be provided as ISO 8601 strings.');
  }

  return parsedValue;
}

function buildCommentOrderBy(
  orderBy: CommentOrderByInput | null | undefined,
): Prisma.CommentOrderByWithRelationInput[] {
  if (orderBy === undefined || orderBy === null || orderBy === 'createdAt') {
    return COMMENT_ORDER_BY.slice();
  }

  return COMMENT_ORDER_BY.slice();
}

function isDefaultCommentOrder(orderBy: CommentOrderByInput | null | undefined): boolean {
  return orderBy === undefined || orderBy === null || orderBy === 'createdAt';
}

function encodeCursor(entity: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: entity.createdAt.toISOString(),
      id: entity.id,
    } satisfies CursorPayload),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(after: string): CursorPayload {
  const parsed = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')) as Partial<CursorPayload>;

  if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
    throw new TypeError('Invalid cursor payload.');
  }

  return {
    createdAt: parsed.createdAt,
    id: parsed.id,
  };
}

function buildPageInfo(
  nodes: Array<{ createdAt: Date; id: string }>,
  hasNextPage: boolean,
): { endCursor: string | null; hasNextPage: boolean } {
  const lastNode = nodes[nodes.length - 1];

  return {
    hasNextPage,
    endCursor: lastNode ? encodeCursor(lastNode) : null,
  };
}

function combineIssueWhere(
  left: Prisma.IssueWhereInput | undefined,
  right: Prisma.IssueWhereInput | undefined,
): Prisma.IssueWhereInput | undefined {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return {
    AND: [left, right],
  };
}

function buildIssueCursorWhere(after: string | null | undefined): Prisma.IssueWhereInput | undefined {
  if (!after) {
    return undefined;
  }

  const cursor = decodeCursor(after);
  const createdAt = parseDateTime(cursor.createdAt);

  return {
    OR: [
      {
        createdAt: {
          lt: createdAt,
        },
      },
      {
        createdAt,
        id: {
          lt: cursor.id,
        },
      },
    ],
  };
}

function buildCommentWhere(
  issueId: string,
  after: string | null | undefined,
): Prisma.CommentWhereInput {
  if (!after) {
    return {
      issueId,
    };
  }

  const cursor = decodeCursor(after);
  const createdAt = parseDateTime(cursor.createdAt);

  return {
    issueId,
    OR: [
      {
        createdAt: {
          gt: createdAt,
        },
      },
      {
        createdAt,
        id: {
          gt: cursor.id,
        },
      },
    ],
  };
}

async function runMutation<TResult extends { success: true }, TFallback extends { success: false }>(
  operation: () => Promise<TResult>,
  fallback: TFallback,
): Promise<TResult | TFallback> {
  try {
    return await operation();
  } catch (error) {
    if (getExposedError(error) || isPrismaInvalidInputError(error)) {
      return fallback;
    }

    throw error;
  }
}
function getRequestedIssueConnectionFields(info: GraphQLResolveInfo): Set<string> {
  const fieldNames = new Set<string>();

  for (const fieldNode of info.fieldNodes) {
    collectIssueConnectionFieldNames(fieldNode.selectionSet, info.fragments, fieldNames, false);
  }

  return fieldNames;
}

function collectIssueConnectionFieldNames(
  selectionSet: SelectionSetNode | undefined,
  fragments: Record<string, FragmentDefinitionNode>,
  fieldNames: Set<string>,
  insideNodes: boolean,
): void {
  if (!selectionSet) {
    return;
  }

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      collectIssueConnectionFieldName(selection, fragments, fieldNames, insideNodes);
      continue;
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      collectIssueConnectionFieldNames(selection.selectionSet, fragments, fieldNames, insideNodes);
      continue;
    }

    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      collectIssueConnectionFieldNames(
        fragments[selection.name.value]?.selectionSet,
        fragments,
        fieldNames,
        insideNodes,
      );
    }
  }
}

function collectIssueConnectionFieldName(
  field: FieldNode,
  fragments: Record<string, FragmentDefinitionNode>,
  fieldNames: Set<string>,
  insideNodes: boolean,
): void {
  if (insideNodes) {
    fieldNames.add(field.name.value);
    return;
  }

  if (field.name.value === 'nodes') {
    collectIssueConnectionFieldNames(field.selectionSet, fragments, fieldNames, true);
    return;
  }

  collectIssueConnectionFieldNames(field.selectionSet, fragments, fieldNames, false);
}
